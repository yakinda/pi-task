/** Built-in coding tools available to child sessions by default. */
export const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const TASK_TOOL_NAME = "task";

export const KNOWN_BUILT_IN_TOOLS = new Set<string>([...CODING_TOOLS, TASK_TOOL_NAME]);

export interface ResolveCapabilitiesInput {
  /** Agent frontmatter tools. `undefined` = omit (request all coding tools). `[]` = explicit empty. */
  agentTools: string[] | undefined;
  /** Parent active built-in tool names from `pi.getActiveTools()`. */
  parentActiveTools: readonly string[];
}

export interface ResolveCapabilitiesResult {
  tools: string[];
  warnings: string[];
}

/**
 * Resolve child tool allowlist:
 *   requested tools = agent.tools ?? seven built-in coding tools
 *   effective tools = requested supported built-ins ∩ parent active tools
 *
 * Rules:
 * - `task` is always removed with a warning
 * - Extension/custom tools are never admitted
 * - Unknown tools produce warnings and are removed
 * - Parent-inactive tools produce warnings and are removed
 * - Empty effective set throws before spawn
 * - Explicit empty agent tools (`[]`) throws before spawn
 */
export function resolveCapabilities(input: ResolveCapabilitiesInput): ResolveCapabilitiesResult {
  const parentActive = new Set(
    input.parentActiveTools.map((t) => t.trim()).filter(Boolean),
  );

  const warnings: string[] = [];
  const requested = expandRequested(input.agentTools);
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const name of requested) {
    if (name === TASK_TOOL_NAME) {
      warnings.push('Tool "task" is not available to child sessions (nested task is disabled)');
      continue;
    }
    if (!KNOWN_BUILT_IN_TOOLS.has(name)) {
      warnings.push(`Unknown or custom tool "${name}" skipped (only built-in coding tools are allowed)`);
      continue;
    }
    if (!parentActive.has(name)) {
      warnings.push(`Tool "${name}" is not active on the parent agent and was skipped`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
  }

  if (tools.length === 0) {
    throw new Error(
      "No usable tools for child session after intersecting agent allowlist with parent active tools. " +
        "List at least one built-in tool that is active on the parent (e.g. read, grep, find).",
    );
  }

  return { tools, warnings };
}

function expandRequested(agentTools: string[] | undefined): string[] {
  if (agentTools === undefined) {
    return [...CODING_TOOLS];
  }

  // Explicit empty allowlist is a hard failure (not treated as omit)
  if (agentTools.length === 0) {
    throw new Error(
      'Agent tools allowlist is explicitly empty (tools: []). ' +
        "Omit the field to request the default coding tools, or list at least one tool.",
    );
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of agentTools) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  if (result.length === 0) {
    throw new Error(
      "Agent tools allowlist is empty after normalizing names. List at least one valid tool.",
    );
  }

  return result;
}
