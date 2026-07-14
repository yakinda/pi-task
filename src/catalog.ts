import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CODING_TOOLS, KNOWN_BUILT_IN_TOOLS, TASK_TOOL_NAME } from "./capabilities.ts";
import { isStrictProviderModelId, isThinkingLevel, type PiThinkingLevel } from "./model.ts";
import {
  buildToolDescription,
  formatAvailableAgents,
} from "./task-contract.ts";

/** Load/config diagnostic emitted during Catalog discovery. */
export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}

/** Stable fingerprint for deduping diagnostic emission per session. */
export function diagnosticFingerprint(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => `${d.code}|${d.path ?? ""}|${d.message}`)
    .sort()
    .join("\n");
}

/**
 * Runtime Agent definition after Catalog discovery.
 * Supported schema: required non-empty name, description, and Markdown body;
 * optional tools, model, and thinking only.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /**
   * Optional tool allowlist.
   * Omitted when frontmatter omits tools; explicit empty is [].
   * Unsupported / nested-task names may still appear; runtime re-filters them.
   */
  tools?: string[];
  model?: string;
  thinking?: PiThinkingLevel;
  /** Agent body markdown (system role text). */
  body: string;
  filePath: string;
}

export interface AgentCatalogSnapshot {
  readonly agents: readonly AgentDefinition[];
  readonly diagnostics: readonly Diagnostic[];
  find(name: string): AgentDefinition | undefined;
  describeForTool(): string;
}

/** Result of loading agents from disk, including fatal directory-read status. */
export interface AgentCatalogLoadResult {
  snapshot: AgentCatalogSnapshot;
  /** True when the agents directory itself could not be listed (not merely missing). */
  fatal: boolean;
}

/** Result of parsing one Agent markdown file. */
export interface ParseAgentFileResult {
  /** Valid definition when required fields pass; may carry non-fatal diagnostics. */
  agent?: AgentDefinition;
  /** Fatal and non-fatal diagnostics for this file (migration, field soft-fail, etc.). */
  diagnostics: Diagnostic[];
  /**
   * First blocking diagnostic when no agent was produced.
   * Prefer `diagnostics`; retained for call sites still checking a single fatal code.
   */
  diagnostic?: Diagnostic;
}

// Re-export contract helpers used by Catalog consumers / tests.
export {
  buildToolDescription,
  formatAvailableAgents,
} from "./task-contract.ts";

/**
 * Discover and validate user agents under `agentsDir` (`~/.pi/agent/agents/*.md`).
 * Invalid files become diagnostics and are skipped. Conflicting normalized names
 * drop all conflicting definitions.
 *
 * Missing directory is non-fatal (empty catalog). A directory that exists but
 * cannot be listed is fatal for Catalog refresh retention.
 */
export function loadAgentCatalog(agentsDir: string): AgentCatalogSnapshot {
  return loadAgentCatalogWithStatus(agentsDir).snapshot;
}

/**
 * Same as {@link loadAgentCatalog} but reports whether the agents directory
 * itself failed fatally (for atomic Catalog refresh retention).
 */
export function loadAgentCatalogWithStatus(agentsDir: string): AgentCatalogLoadResult {
  const diagnostics: Diagnostic[] = [];
  const loaded: AgentDefinition[] = [];

  if (!fs.existsSync(agentsDir)) {
    return { snapshot: createSnapshot([], diagnostics), fatal: false };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({
      code: "catalog_read_error",
      message: `Could not read agents directory: ${err instanceof Error ? err.message : String(err)}`,
      path: agentsDir,
    });
    return { snapshot: createSnapshot([], diagnostics), fatal: true };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(agentsDir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      diagnostics.push({
        code: "agent_read_error",
        message: `Could not read agent file: ${err instanceof Error ? err.message : String(err)}`,
        path: filePath,
      });
      continue;
    }

    const parsed = parseAgentFile(content, filePath);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.agent) loaded.push(parsed.agent);
  }

  // Canonical-name conflict detection only (case-insensitive).
  // Fail closed: every definition involved in an ambiguous normalized name is dropped.
  const byKey = new Map<string, AgentDefinition[]>();
  for (const agent of loaded) {
    const key = normalizeAgentName(agent.name);
    const list = byKey.get(key) ?? [];
    list.push(agent);
    byKey.set(key, list);
  }

  const dropped = new Set<AgentDefinition>();
  const conflictDiagnostics: Diagnostic[] = [];
  for (const [key, group] of byKey) {
    if (group.length <= 1) continue;
    for (const agent of group) dropped.add(agent);
    const paths = [...group]
      .map((a) => a.filePath)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    conflictDiagnostics.push({
      code: "agent_name_conflict",
      message: `Multiple agents share the canonical name "${key}" (case-insensitive); all conflicting definitions were dropped: ${paths}`,
      // Deterministic path: earliest source path for this conflict group.
      path: [...group].map((a) => a.filePath).sort((a, b) => a.localeCompare(b))[0],
    });
  }
  diagnostics.push(...conflictDiagnostics);

  const agents: AgentDefinition[] = loaded.filter((a) => !dropped.has(a));

  agents.sort((a, b) => a.name.localeCompare(b.name));
  diagnostics.sort((a, b) => {
    const pa = a.path ?? "";
    const pb = b.path ?? "";
    if (pa !== pb) return pa.localeCompare(pb);
    return a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
  });

  return { snapshot: createSnapshot(agents, diagnostics), fatal: false };
}

/**
 * Parse one Agent markdown file into a reduced definition and diagnostics.
 *
 * Fatal (no agent): missing/invalid frontmatter, missing name/description/body,
 * malformed tools.
 * Soft (agent retained): removed aliases/tags/skills migration warnings,
 * invalid model/thinking omitted, unsupported tool names.
 * Unknown unrelated frontmatter is ignored.
 */
export function parseAgentFile(
  content: string,
  filePath: string,
): ParseAgentFileResult {
  if (!content.trimStart().startsWith("---")) {
    return fatalParseResult({
      code: "agent_no_frontmatter",
      message: "Agent file has no YAML frontmatter",
      path: filePath,
    });
  }

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    body = (parsed.body ?? "").trim();
  } catch (err) {
    return fatalParseResult({
      code: "agent_frontmatter_parse",
      message: `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      path: filePath,
    });
  }

  const diagnostics: Diagnostic[] = [];

  const name = asNonEmptyString(frontmatter.name);
  if (!name) {
    return fatalParseResult({
      code: "agent_missing_name",
      message: "Agent frontmatter requires a non-empty string `name`",
      path: filePath,
    });
  }

  const description = asNonEmptyString(frontmatter.description);
  if (!description) {
    return fatalParseResult({
      code: "agent_missing_description",
      message: "Agent frontmatter requires a non-empty string `description`",
      path: filePath,
    });
  }

  if (!body) {
    return fatalParseResult({
      code: "agent_missing_body",
      message: "Agent file requires a non-empty Markdown body after frontmatter",
      path: filePath,
    });
  }

  // Removed fields: migration diagnostics whenever present (including YAML null);
  // do not reject an otherwise valid definition.
  if (frontmatter.aliases !== undefined) {
    diagnostics.push({
      code: "agent_removed_field_aliases",
      message:
        "Agent frontmatter `aliases` is no longer supported and was ignored. " +
        "Use the canonical `name` for Task `subagent_type` lookups. Remove `aliases` from this file.",
      path: filePath,
    });
  }
  if (frontmatter.tags !== undefined) {
    diagnostics.push({
      code: "agent_removed_field_tags",
      message:
        "Agent frontmatter `tags` is no longer supported and was ignored. " +
        "Remove `tags` from this file; Catalog search by tag is unavailable.",
      path: filePath,
    });
  }
  if (frontmatter.skills !== undefined) {
    diagnostics.push({
      code: "agent_removed_field_skills",
      message:
        "Agent frontmatter `skills` is no longer supported and was ignored. " +
        "Child Sessions do not load Skills; remove `skills` from this file.",
      path: filePath,
    });
  }

  const tools = parseTools(frontmatter.tools, filePath);
  if (tools.error) {
    const all = [...diagnostics, tools.error];
    return {
      diagnostics: all,
      diagnostic: tools.error,
    };
  }
  if (tools.value !== undefined) {
    diagnostics.push(...diagnoseToolNames(tools.value, filePath));
  }

  let model: string | undefined;
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model !== "string" || !frontmatter.model.trim()) {
      diagnostics.push({
        code: "agent_invalid_model",
        message:
          "Agent frontmatter `model` must be a non-empty string (provider/modelId); ignoring (parent model will be used)",
        path: filePath,
      });
    } else {
      model = frontmatter.model.trim();
      // Keep agent even if model id is not strict; cascade will warn/skip
      if (!isStrictProviderModelId(model)) {
        // still accept; model resolver will warn
      }
    }
  }

  let thinking: PiThinkingLevel | undefined;
  if (frontmatter.thinking !== undefined) {
    if (typeof frontmatter.thinking !== "string") {
      diagnostics.push({
        code: "agent_invalid_thinking",
        message:
          "Agent frontmatter `thinking` must be a string; ignoring (parent thinking level will be used)",
        path: filePath,
      });
    } else {
      const level = frontmatter.thinking.trim().toLowerCase();
      if (!isThinkingLevel(level)) {
        diagnostics.push({
          code: "agent_invalid_thinking",
          message: `Agent frontmatter \`thinking\` has invalid value "${frontmatter.thinking}"; ignoring (parent thinking level will be used)`,
          path: filePath,
        });
      } else {
        thinking = level as PiThinkingLevel;
      }
    }
  }

  return {
    agent: {
      name,
      description,
      tools: tools.value,
      model,
      thinking,
      body,
      filePath,
    },
    diagnostics,
  };
}

export function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

/** Result of an atomic Catalog reload attempt. */
export interface CatalogRefreshResult {
  /** True when a new candidate replaced the live snapshot. */
  readonly swapped: boolean;
  /** Live snapshot after the operation (new or retained). */
  readonly snapshot: AgentCatalogSnapshot;
  /**
   * Diagnostics to report for this refresh attempt.
   * On successful swap: the new snapshot diagnostics.
   * On fatal retention: the fatal failure diagnostics (snapshot stays known-good).
   */
  readonly diagnostics: readonly Diagnostic[];
  readonly fatal: boolean;
}

/**
 * Mutable holder for an immutable Catalog snapshot.
 * Reload is atomic: fatal directory reads retain the previous known-good snapshot.
 */
export function createCatalogHolder(agentsDir: string): {
  get(): AgentCatalogSnapshot;
  refresh(): CatalogRefreshResult;
} {
  // Empty known-good until the first successful refresh (silent initial load).
  let current = createSnapshot([], []);

  return {
    get() {
      return current;
    },
    refresh() {
      const load = loadAgentCatalogWithStatus(agentsDir);
      if (load.fatal) {
        return {
          swapped: false,
          snapshot: current,
          diagnostics: load.snapshot.diagnostics,
          fatal: true,
        };
      }
      current = load.snapshot;
      return {
        swapped: true,
        snapshot: current,
        diagnostics: current.diagnostics,
        fatal: false,
      };
    },
  };
}

function fatalParseResult(diagnostic: Diagnostic): ParseAgentFileResult {
  return {
    diagnostics: [diagnostic],
    diagnostic,
  };
}

function createSnapshot(
  agents: AgentDefinition[],
  diagnostics: Diagnostic[],
): AgentCatalogSnapshot {
  const list = Object.freeze([...agents]);
  const diags = Object.freeze([...diagnostics]);
  const byName = buildCanonicalNameIndex(list);
  return {
    agents: list,
    diagnostics: diags,
    find(name: string) {
      return byName.get(normalizeAgentName(name));
    },
    describeForTool() {
      return buildToolDescription(list);
    },
  };
}

/** Map every non-conflicting normalized canonical name → definition. */
function buildCanonicalNameIndex(
  agents: readonly AgentDefinition[],
): Map<string, AgentDefinition> {
  const index = new Map<string, AgentDefinition>();
  for (const agent of agents) {
    index.set(normalizeAgentName(agent.name), agent);
  }
  return index;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse optional tools: omit → undefined; array or CSV string → list.
 * Empty array is explicit empty allowlist — keep as [].
 * Malformed type or non-string list members reject the definition (capability safety).
 */
function parseTools(
  value: unknown,
  filePath: string,
): { value?: string[]; error?: Diagnostic } {
  if (value === undefined) return { value: undefined };

  if (Array.isArray(value)) {
    const tools: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        return {
          error: {
            code: "agent_invalid_tools",
            message: "Agent frontmatter `tools` array entries must be strings",
            path: filePath,
          },
        };
      }
      const t = item.trim();
      if (t) tools.push(t);
    }
    // Empty array is explicit empty allowlist — keep as []
    return { value: tools };
  }

  if (typeof value === "string") {
    const tools = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return { value: tools };
  }

  return {
    error: {
      code: "agent_invalid_tools",
      message: "Agent frontmatter `tools` must be a string list or comma-separated string",
      path: filePath,
    },
  };
}

/**
 * Discovery diagnostics for unsupported / custom / nested-task tool names.
 * Coordinates with the shared built-in list in capabilities.ts.
 * Does not alter the tools list — runtime re-filters independently.
 */
function diagnoseToolNames(
  tools: readonly string[],
  filePath: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (name === TASK_TOOL_NAME) {
      diagnostics.push({
        code: "agent_nested_task_tool",
        message:
          `Agent tools list includes nested "${TASK_TOOL_NAME}", which is not available to Child Sessions; ` +
          "it will be removed at Task preparation. Remove it from the allowlist.",
        path: filePath,
      });
      continue;
    }

    if (!KNOWN_BUILT_IN_TOOLS.has(name)) {
      const supported = CODING_TOOLS.join(", ");
      diagnostics.push({
        code: "agent_unsupported_tool",
        message:
          `Agent tools list includes unsupported or custom tool "${name}"; ` +
          `only built-in coding tools are allowed (${supported}). ` +
          "It will be removed at Task preparation.",
        path: filePath,
      });
    }
  }
  return diagnostics;
}
