/**
 * Compact model-facing Task contract.
 *
 * One internal builder owns provider-facing Task parameter metadata, tool
 * description, prompt snippet, prompt guidelines, bounded Catalog summary,
 * and empty/unknown-agent messaging. Policy facts appear exactly once across
 * the provider-facing surface.
 */
import type { AgentDefinition } from "./catalog.ts";

/** Local normalize to avoid circular runtime import with catalog.ts. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Documented budgets (characters, UTF-16 length for simplicity / determinism)
// ---------------------------------------------------------------------------

/** Max characters retained from one Agent definition description in model metadata. */
export const TASK_CATALOG_DESCRIPTION_BUDGET = 120;

/**
 * Max characters for the Catalog block inside the Task tool description
 * (header + agent lines + optional omitted marker), before the total
 * provider-facing budget further constrains it.
 */
export const TASK_CATALOG_METADATA_BUDGET = 900;

/**
 * Hard total budget for all provider-facing Task metadata registered with Pi:
 * tool description (static core + Catalog block) + prompt snippet + guidelines
 * + all parameter descriptions. The contract builder budgets Catalog metadata
 * dynamically after fixed static overhead so empty / representative / huge
 * Catalogs all stay within this limit.
 */
export const TASK_PROVIDER_METADATA_BUDGET = 1800;

/** Max characters for unknown-agent / empty-Catalog runtime error messages. */
export const TASK_ERROR_MESSAGE_BUDGET = 600;

// ---------------------------------------------------------------------------
// Static policy (each fact once; guidelines name Task explicitly)
// ---------------------------------------------------------------------------

/** One-line Available-tools snippet. */
export const TASK_PROMPT_SNIPPET =
  "Specialized foreground Task: delegate complex multistep work to a user Agent definition in an isolated Child Session.";

/**
 * Prompt guidelines flattened into Pi's Guidelines section.
 * Each bullet explicitly names the Task tool (Pi does not re-attribute them).
 * Concurrency / nesting / direct-work / no-duplicate policy lives here only.
 */
export const TASK_PROMPT_GUIDELINES: readonly string[] = [
  "Prefer direct read/grep/find for known files, symbols, or small search areas instead of Task.",
  "Do not use Task when no available Agent definition fits; use other tools directly.",
  "After launching Task, do not duplicate the delegated work in the parent; continue only non-overlapping work or wait.",
  "Nested Task calls are unavailable inside Child Sessions.",
  "Launch concurrent Task calls only for independent research scopes or explicitly partitioned mutation scopes.",
  "Never run concurrent Task mutations that touch overlapping files or operations.",
];

/**
 * Compact static body for the tool `description` field.
 * Does not restate guideline policy (those live in promptGuidelines).
 * Catalog summary is appended separately under a dynamic budget.
 */
export const TASK_TOOL_DESCRIPTION_CORE = [
  "Foreground Task: run a specialized Agent definition in an isolated Child Session and return one final result.",
  "Required: description (3–5 words, ≤120 chars), prompt (detailed delegated instructions), subagent_type (canonical Agent name, case-insensitive).",
  "Each Task starts a fresh conversation; give a highly detailed prompt and say exactly what to return.",
  "Result is returned to you, not shown to the user — summarize outcomes yourself.",
].join(" ");

/** Parameter schema guidance — no duplicated policy facts. */
export const TASK_PARAMETER_DESCRIPTIONS = {
  description: "Short 3–5 word summary of the Task (max 120 characters).",
  prompt: "Full delegated instructions for the Child Session (only user message content).",
  subagent_type:
    "Canonical Agent definition name from the Catalog (case-insensitive). Prefer advertised names.",
} as const;

// ---------------------------------------------------------------------------
// Catalog summary (bounded, deterministic)
// ---------------------------------------------------------------------------

export interface CatalogSummaryOptions {
  /** Per-description character budget. Default: TASK_CATALOG_DESCRIPTION_BUDGET. */
  descriptionBudget?: number;
  /**
   * Total Catalog metadata character budget.
   * Default when used via buildTaskToolContract: dynamically derived so the
   * full provider-facing surface stays within TASK_PROVIDER_METADATA_BUDGET.
   * Default when used via buildBoundedCatalogSummary directly:
   * TASK_CATALOG_METADATA_BUDGET.
   */
  metadataBudget?: number;
}

export interface BoundedCatalogSummary {
  /** Bounded text for inclusion in tool description. */
  text: string;
  /** Canonical names included in the summary (in order). */
  includedNames: string[];
  /** Number of agents fully omitted (names not advertised due to budget). */
  omittedCount: number;
  /** Whether any included description was truncated. */
  truncatedDescriptions: boolean;
}

/**
 * Fixed provider-facing overhead excluding the Catalog block:
 * static tool-description core + "\n\n" separator + snippet + guidelines +
 * all parameter descriptions. Catalog metadata is budgeted from what remains
 * under TASK_PROVIDER_METADATA_BUDGET.
 */
export function measureFixedProviderFacingOverhead(): number {
  return (
    TASK_TOOL_DESCRIPTION_CORE.length +
    2 + // "\n\n" between core and Catalog block
    TASK_PROMPT_SNIPPET.length +
    TASK_PROMPT_GUIDELINES.join("\n").length +
    TASK_PARAMETER_DESCRIPTIONS.description.length +
    TASK_PARAMETER_DESCRIPTIONS.prompt.length +
    TASK_PARAMETER_DESCRIPTIONS.subagent_type.length
  );
}

/**
 * Catalog metadata budget after fixed static overhead, capped by the Catalog
 * block max and any explicit options.metadataBudget.
 */
export function computeCatalogMetadataBudget(
  options: CatalogSummaryOptions = {},
): number {
  const remaining = Math.max(
    0,
    TASK_PROVIDER_METADATA_BUDGET - measureFixedProviderFacingOverhead(),
  );
  const requested = options.metadataBudget ?? TASK_CATALOG_METADATA_BUDGET;
  return Math.min(requested, remaining);
}

/**
 * Build a deterministic, budgeted Catalog summary for model-facing metadata.
 *
 * Truncation order (canonical names preferred):
 * 1. Truncate each description to the per-description budget.
 * 2. Drop descriptions entirely if needed; keep all canonical names.
 * 3. If still over budget, omit trailing agents and append an omitted-count marker.
 *
 * Extreme tiny budgets hard-truncate the rendered text (including marker) so
 * output is always deterministic and within budget.
 */
export function buildBoundedCatalogSummary(
  agents: readonly AgentDefinition[],
  options: CatalogSummaryOptions = {},
): BoundedCatalogSummary {
  const descriptionBudget = options.descriptionBudget ?? TASK_CATALOG_DESCRIPTION_BUDGET;
  const metadataBudget = options.metadataBudget ?? TASK_CATALOG_METADATA_BUDGET;

  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    const text = emptyCatalogMessage();
    return {
      text: boundText(text, metadataBudget),
      includedNames: [],
      omittedCount: 0,
      truncatedDescriptions: false,
    };
  }

  type LinePlan = {
    name: string;
    withDesc: string;
    nameOnly: string;
    truncated: boolean;
  };

  const plans: LinePlan[] = sorted.map((a) => {
    const { text: desc, truncated } = truncateDescription(a.description, descriptionBudget);
    return {
      name: a.name,
      withDesc: `- ${a.name}: ${desc}`,
      nameOnly: `- ${a.name}`,
      truncated,
    };
  });

  let truncatedDescriptions = plans.some((p) => p.truncated);

  type RenderMode = "desc" | "name";
  let included = plans.length;
  let mode: RenderMode = "desc";

  const lineFor = (p: LinePlan, m: RenderMode): string =>
    m === "desc" ? p.withDesc : p.nameOnly;

  const render = (count: number, m: RenderMode, omitted: number): string => {
    const header = "Available agents:";
    const body = plans
      .slice(0, count)
      .map((p) => lineFor(p, m))
      .join("\n");
    const marker =
      omitted > 0
        ? `\n(+${omitted} more agent(s) callable by canonical name, not listed)`
        : "";
    return `${header}\n${body}${marker}`;
  };

  // Phase 1: name + truncated description
  let text = render(included, "desc", 0);
  if (text.length > metadataBudget) {
    // Phase 2: names only for all agents
    mode = "name";
    text = render(included, mode, 0);
  }

  if (text.length > metadataBudget) {
    // Phase 3: omit trailing names until under budget
    mode = "name";
    let lo = 0;
    let hi = plans.length;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const omitted = plans.length - mid;
      const candidate = render(mid, "name", omitted);
      if (candidate.length <= metadataBudget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    included = best;
    text = render(included, "name", plans.length - included);
    // Extreme case: even zero names + marker exceeds budget — hard truncate
    if (text.length > metadataBudget) {
      text = boundText(text, metadataBudget);
    }
  }

  const useDescriptions = mode === "desc";
  if (!useDescriptions) {
    truncatedDescriptions = truncatedDescriptions || plans.some((p) => p.truncated);
  }

  return {
    text,
    includedNames: plans.slice(0, included).map((p) => p.name),
    omittedCount: plans.length - included,
    truncatedDescriptions: useDescriptions ? truncatedDescriptions : plans.some((p) => p.truncated),
  };
}

export function truncateDescription(
  description: string,
  budget: number = TASK_CATALOG_DESCRIPTION_BUDGET,
): { text: string; truncated: boolean } {
  const trimmed = description.trim().replace(/\s+/g, " ");
  if (trimmed.length <= budget) {
    return { text: trimmed, truncated: false };
  }
  if (budget <= 1) {
    return { text: "…", truncated: true };
  }
  return { text: `${trimmed.slice(0, budget - 1)}…`, truncated: true };
}

// ---------------------------------------------------------------------------
// Provider-facing tool description
// ---------------------------------------------------------------------------

export interface TaskToolContract {
  /** Tool description (static core + bounded Catalog). */
  description: string;
  /** One-line prompt snippet. */
  promptSnippet: string;
  /** Task-named guidelines (each policy fact once). */
  promptGuidelines: readonly string[];
  /** Parameter description strings. */
  parameterDescriptions: typeof TASK_PARAMETER_DESCRIPTIONS;
  /** Bounded Catalog summary details (for tests / diagnostics). */
  catalogSummary: BoundedCatalogSummary;
}

/**
 * Build the full provider-facing Task tool contract for the current Catalog.
 * Catalog metadata is budgeted after fixed static overhead so
 * measureProviderFacingMetadata(...).totalChars stays within
 * TASK_PROVIDER_METADATA_BUDGET.
 */
export function buildTaskToolContract(
  agents: readonly AgentDefinition[],
  options: CatalogSummaryOptions = {},
): TaskToolContract {
  const metadataBudget = computeCatalogMetadataBudget(options);
  const catalogSummary = buildBoundedCatalogSummary(agents, {
    ...options,
    metadataBudget,
  });
  const description = `${TASK_TOOL_DESCRIPTION_CORE}\n\n${catalogSummary.text}`;
  return {
    description,
    promptSnippet: TASK_PROMPT_SNIPPET,
    promptGuidelines: TASK_PROMPT_GUIDELINES,
    parameterDescriptions: TASK_PARAMETER_DESCRIPTIONS,
    catalogSummary,
  };
}

/**
 * Provider-facing tool description only (used by Catalog.describeForTool).
 */
export function buildToolDescription(
  agents: readonly AgentDefinition[],
  options: CatalogSummaryOptions = {},
): string {
  return buildTaskToolContract(agents, options).description;
}

// ---------------------------------------------------------------------------
// Runtime error messages (bounded, deterministic, helpful)
// ---------------------------------------------------------------------------

export function emptyCatalogMessage(): string {
  return (
    "No Agent definitions configured. Add markdown under ~/.pi/agent/agents/ " +
    "(required: name, description frontmatter and a non-empty Markdown body; " +
    "optional: tools, model, thinking), then start a new session to reload."
  );
}

/**
 * Human-oriented full agent listing (unbounded descriptions) for doctor/list.
 * Not used in provider-facing tool metadata.
 */
export function formatAvailableAgents(agents: readonly AgentDefinition[]): string {
  if (agents.length === 0) {
    return "(none — add markdown agents under ~/.pi/agent/agents/)";
  }
  return [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");
}

/**
 * Bounded listing for unknown-agent errors. Preserves canonical names;
 * truncates descriptions; may omit trailing agents under budget.
 */
export function formatAvailableAgentsBounded(
  agents: readonly AgentDefinition[],
  budget: number = TASK_ERROR_MESSAGE_BUDGET,
): string {
  if (agents.length === 0) {
    return "(none)";
  }
  const summary = buildBoundedCatalogSummary(agents, {
    descriptionBudget: Math.min(80, TASK_CATALOG_DESCRIPTION_BUDGET),
    metadataBudget: Math.max(40, budget - 40),
  });
  // Strip the "Available agents:" header for embedding under "Available agents:\n"
  return summary.text.replace(/^Available agents:\n?/, "") || "(none)";
}

export function formatEmptyCatalogError(requested: string): string {
  const msg = `${emptyCatalogMessage()}\nRequested: ${boundInline(requested, 80)}`;
  return boundText(msg, TASK_ERROR_MESSAGE_BUDGET);
}

export function formatUnknownAgentError(
  requested: string,
  agents: readonly AgentDefinition[],
): string {
  if (agents.length === 0) {
    return formatEmptyCatalogError(requested);
  }
  const listing = formatAvailableAgentsBounded(agents);
  const msg = `Unknown subagent_type "${boundInline(requested, 80)}". Available agents:\n${listing}`;
  return boundText(msg, TASK_ERROR_MESSAGE_BUDGET);
}

/**
 * Collect every provider-facing static text surface for policy-fact assertions.
 * Catalog agent lines are excluded so tests measure static policy once.
 */
export function collectStaticProviderFacingText(): string {
  return [
    TASK_TOOL_DESCRIPTION_CORE,
    TASK_PROMPT_SNIPPET,
    ...TASK_PROMPT_GUIDELINES,
    TASK_PARAMETER_DESCRIPTIONS.description,
    TASK_PARAMETER_DESCRIPTIONS.prompt,
    TASK_PARAMETER_DESCRIPTIONS.subagent_type,
  ].join("\n");
}

/**
 * Full provider-facing metadata string as registered with Pi
 * (description + snippet + guidelines + param descriptions).
 * totalChars must stay ≤ TASK_PROVIDER_METADATA_BUDGET for every Catalog size.
 */
export function measureProviderFacingMetadata(agents: readonly AgentDefinition[]): {
  totalChars: number;
  descriptionChars: number;
  catalogChars: number;
  staticChars: number;
  fixedOverhead: number;
  catalogBudget: number;
  contract: TaskToolContract;
} {
  const fixedOverhead = measureFixedProviderFacingOverhead();
  const catalogBudget = computeCatalogMetadataBudget();
  const contract = buildTaskToolContract(agents);
  const staticPart = collectStaticProviderFacingText();
  const total =
    contract.description.length +
    TASK_PROMPT_SNIPPET.length +
    TASK_PROMPT_GUIDELINES.join("\n").length +
    TASK_PARAMETER_DESCRIPTIONS.description.length +
    TASK_PARAMETER_DESCRIPTIONS.prompt.length +
    TASK_PARAMETER_DESCRIPTIONS.subagent_type.length;
  return {
    totalChars: total,
    descriptionChars: contract.description.length,
    catalogChars: contract.catalogSummary.text.length,
    staticChars: staticPart.length,
    fixedOverhead,
    catalogBudget,
    contract,
  };
}

/** Case-insensitive check that every agent remains findable by advertised name. */
export function allAgentsCallable(
  agents: readonly AgentDefinition[],
  find: (name: string) => AgentDefinition | undefined,
): boolean {
  for (const agent of agents) {
    if (!find(agent.name)) return false;
    if (!find(agent.name.toUpperCase())) return false;
    if (!find(normalizeName(agent.name))) return false;
  }
  return true;
}

function boundInline(text: string, budget: number): string {
  const inline = String(text).replace(/\s+/g, " ").trim();
  return boundText(inline, budget);
}

function boundText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 1) return "…";
  return `${text.slice(0, budget - 1)}…`;
}
