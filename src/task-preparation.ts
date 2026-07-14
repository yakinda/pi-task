import type { AgentDefinition } from "./catalog.ts";
import { resolveCapabilities } from "./capabilities.ts";
import {
  resolveModel,
  type ModelRegistryLike,
  type ModelSource,
  type ParentModel,
  type PiThinkingLevel,
} from "./model.ts";

/** Deterministic error when the parent active-tool API is missing or throws. */
export const ACTIVE_TOOLS_UNAVAILABLE_ERROR =
  "Task failed: parent active tools are unavailable; cannot resolve child capabilities";

/**
 * Runtime inputs shared by Task execution preparation and Catalog doctor.
 * Consumes the current Primary-agent snapshot; never contacts a provider.
 * Never reads settings.subagents.
 */
export interface TaskPreparationRuntime {
  parentModel: ParentModel | undefined;
  modelRegistry: ModelRegistryLike | undefined;
  parentThinking: PiThinkingLevel | undefined;
  /**
   * Parent active built-in tool names when the active-tool API succeeded.
   * Empty array means the parent truly has no active tools (fails after intersection).
   */
  activeTools: readonly string[];
  /**
   * When true, `pi.getActiveTools` was missing or threw. Preparation fails closed
   * with a distinct error and never treats this as a valid empty tool list.
   */
  activeToolsApiFailed?: boolean;
  projectTrusted: boolean;
}

/**
 * Fully resolved Task configuration after model/thinking/tool cascade.
 * Ready for Child Session creation (execution) or doctor reporting.
 */
export interface PreparedTask {
  agent: AgentDefinition;
  tools: string[];
  model: ParentModel;
  modelId: string;
  source: ModelSource;
  thinking: PiThinkingLevel | undefined;
  warnings: string[];
  projectTrusted: boolean;
}

export interface TaskPreparationSuccess {
  ok: true;
  prepared: PreparedTask;
}

/**
 * Preparation failure with any partial cascade data gathered before the error.
 * Used by doctor so one bad definition cannot hide other diagnostics.
 */
export interface TaskPreparationFailure {
  ok: false;
  agent: AgentDefinition;
  error: string;
  warnings: string[];
  /** Effective tools when capability resolution succeeded before a later failure. */
  tools?: string[];
  modelId?: string;
  modelSource?: ModelSource | string;
  thinking?: PiThinkingLevel;
  projectTrusted: boolean;
}

export type TaskPreparationResult = TaskPreparationSuccess | TaskPreparationFailure;

/**
 * Resolve effective model, thinking, tools, and Warnings for one Agent definition
 * using the same rules as Task execution. Never creates a Child Session or
 * issues a provider/model request. Never reads settings.subagents.
 *
 * Capability and model resolution are pure against the supplied runtime snapshot.
 */
export function prepareAgentTask(
  agent: AgentDefinition,
  runtime: TaskPreparationRuntime,
): TaskPreparationResult {
  const projectTrusted = runtime.projectTrusted;
  const warnings: string[] = [];
  let tools: string[] | undefined;

  if (runtime.activeToolsApiFailed) {
    return {
      ok: false,
      agent,
      error: ACTIVE_TOOLS_UNAVAILABLE_ERROR,
      warnings: dedupeWarnings(warnings),
      projectTrusted,
    };
  }

  try {
    const caps = resolveCapabilities({
      agentTools: agent.tools,
      parentActiveTools: runtime.activeTools,
    });
    tools = caps.tools;
    warnings.push(...caps.warnings);
  } catch (err) {
    return {
      ok: false,
      agent,
      error: err instanceof Error ? err.message : String(err),
      warnings: dedupeWarnings(warnings),
      projectTrusted,
    };
  }

  if (!runtime.modelRegistry) {
    return {
      ok: false,
      agent,
      error:
        "Task failed: parent model registry is unavailable; cannot resolve a runnable child model",
      warnings: dedupeWarnings(warnings),
      tools,
      thinking: agent.thinking as PiThinkingLevel | undefined,
      projectTrusted,
    };
  }

  try {
    const resolved = resolveModel(agent, {
      parentModel: runtime.parentModel,
      modelRegistry: runtime.modelRegistry,
      parentThinking: runtime.parentThinking,
    });
    warnings.push(...resolved.warnings);

    return {
      ok: true,
      prepared: {
        agent,
        tools,
        model: resolved.model,
        modelId: resolved.modelId,
        source: resolved.source,
        thinking: resolved.thinking,
        warnings: dedupeWarnings(warnings),
        projectTrusted,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // resolveModel embeds cascade Warnings in the thrown message.
    warnings.push(...extractEmbeddedWarnings(error));
    return {
      ok: false,
      agent,
      error,
      warnings: dedupeWarnings(warnings),
      tools,
      thinking: (agent.thinking as PiThinkingLevel | undefined) ?? runtime.parentThinking,
      projectTrusted,
    };
  }
}

/**
 * Same as {@link prepareAgentTask} but throws on failure — used by TaskExecutor
 * so execution error messages stay identical to historical behavior.
 */
export function prepareAgentTaskOrThrow(
  agent: AgentDefinition,
  runtime: TaskPreparationRuntime,
): PreparedTask {
  const result = prepareAgentTask(agent, runtime);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.prepared;
}

export function dedupeWarnings(warnings: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of warnings) {
    const key = w.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * resolveModel appends `Warnings: a; b` to its failure message.
 * Recover those for doctor reporting without changing the throw contract.
 */
function extractEmbeddedWarnings(message: string): string[] {
  const marker = "Warnings: ";
  const idx = message.indexOf(marker);
  if (idx < 0) return [];
  const tail = message.slice(idx + marker.length).trim();
  if (!tail) return [];
  return tail
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
