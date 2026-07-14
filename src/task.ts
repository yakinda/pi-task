import type { AgentCatalogSnapshot, AgentDefinition } from "./catalog.ts";
import {
  formatEmptyCatalogError,
  formatUnknownAgentError,
} from "./task-contract.ts";
import {
  createChildSessionRunner,
  type ChildActivityEvent,
  type ChildSessionRunner,
} from "./child-session.ts";
import type {
  ModelRegistryLike,
  ParentModel,
  PiThinkingLevel,
} from "./model.ts";
import {
  normalizeSuccessResult,
  SUMMARY_MAX_CHARS,
} from "./result.ts";
import { Semaphore, taskSemaphore } from "./semaphore.ts";
import type { Diagnostic } from "./catalog.ts";
import {
  dedupeWarnings,
  prepareAgentTaskOrThrow,
  type TaskPreparationRuntime,
} from "./task-preparation.ts";
import {
  createTimingTracker,
  defaultClock,
  formatPhaseProgressText,
  type Clock,
  type TaskPhase,
} from "./task-report.ts";

export type { Clock, TaskPhase } from "./task-report.ts";

export interface TaskRequest {
  description: string;
  prompt: string;
  subagentType: string;
}

export interface TaskRuntime {
  cwd: string;
  parentModel: ParentModel | undefined;
  modelRegistry: ModelRegistryLike | undefined;
  parentThinking: PiThinkingLevel | undefined;
  /** Parent active tools when the active-tool API succeeded. */
  activeTools: string[];
  /**
   * When true, parent active-tool API was missing or threw. Preparation fails closed
   * and never treats this as a valid empty active-tool list.
   */
  activeToolsApiFailed?: boolean;
  projectTrusted: boolean;
  /**
   * Warnings from Primary runtime snapshot construction (e.g. fail-closed trust lookup).
   * Merged into Task details and successful model-channel envelope; never alters lifecycle.
   */
  warnings?: readonly string[];
  signal?: AbortSignal;
}

/** Slice of TaskRuntime used by shared preparation / doctor. */
export function toPreparationRuntime(runtime: TaskRuntime): TaskPreparationRuntime {
  return {
    parentModel: runtime.parentModel,
    modelRegistry: runtime.modelRegistry,
    parentThinking: runtime.parentThinking,
    activeTools: runtime.activeTools,
    activeToolsApiFailed: runtime.activeToolsApiFailed,
    projectTrusted: runtime.projectTrusted,
  };
}

/**
 * Current live tool status for partial progress.
 * Name and status only — no toolCallId, args, or output.
 * Not retained as history; terminal details omit this field.
 */
export interface TaskCurrentTool {
  toolName: string;
  status: "running" | "completed" | "error";
}

/**
 * Minimal Task details for one foreground invocation.
 * No modelSource, usage, queue pressure, activity history, detailed timing
 * nesting, retention/truncation metadata, or artifact fields.
 */
export interface TaskDetails {
  /** Resolved Agent definition name. */
  agent?: string;
  /** Resolved model id (provider/id). Optional when unavailable. */
  model?: string;
  /** Effective child thinking level after cascade. Optional when unavailable. */
  thinking?: PiThinkingLevel;
  /** Effective child tools after Parent capability snapshot intersection. */
  tools?: string[];
  /**
   * Shared warnings — exactly the same list as model-facing success XML
   * `<warnings>` on completed Tasks.
   */
  warnings: string[];
  description: string;
  /** Requested `subagent_type` (as validated from the call). */
  subagentType: string;
  /**
   * Full delegated prompt — human-only presentation field.
   * Never appears in model-visible XML or progress text.
   */
  prompt?: string;
  /**
   * Normalized capped Task result text (same logical content as XML `<task_result>`).
   * Human-only presentation field; never enters Primary-agent model context merely
   * by existing here. Exact match of the model-channel payload after sanitation + soft-cap.
   */
  resultText?: string;
  /** Lifecycle phase (queued → running → terminal). */
  phase?: TaskPhase;
  /**
   * Total wall time from Task start to this snapshot, in milliseconds.
   * Always non-negative. Direct field — no TaskTiming/startedAt nesting.
   */
  elapsedMs?: number;
  /**
   * Current live tool name/status for partial progress only.
   * Omitted from terminal details; never accumulates history or arguments.
   */
  currentTool?: TaskCurrentTool;
}

export interface TaskProgress {
  text: string;
  details: TaskDetails;
}

export interface TaskExecutionResult {
  text: string;
  details: TaskDetails;
}

export interface TaskExecutor {
  execute(
    request: TaskRequest,
    runtime: TaskRuntime,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<TaskExecutionResult>;
}

export interface CreateTaskExecutorOptions {
  catalog: () => AgentCatalogSnapshot;
  childSession?: ChildSessionRunner;
  semaphore?: Semaphore;
  diagnosticSink?: (diagnostics: readonly Diagnostic[]) => void;
  /** Injectable clock for deterministic timing tests (epoch ms). */
  clock?: Clock;
}

export function createTaskExecutor(options: CreateTaskExecutorOptions): TaskExecutor {
  const childSession = options.childSession ?? createChildSessionRunner();
  const semaphore = options.semaphore ?? taskSemaphore;
  const clock = options.clock ?? defaultClock;

  return {
    async execute(request, runtime, onProgress) {
      const validated = validateTaskRequest(request);
      const catalog = options.catalog();

      // Catalog diagnostics are observational. Surface the current snapshot to
      // programmatic consumers without allowing a sink failure to alter Task execution.
      try {
        options.diagnosticSink?.(catalog.diagnostics);
      } catch {
        // Diagnostic reporting must not change validation, lifecycle, or cleanup.
      }

      const agent = catalog.find(validated.subagentType);
      if (!agent) {
        if (catalog.agents.length === 0) {
          throw new Error(formatEmptyCatalogError(validated.subagentType));
        }
        throw new Error(formatUnknownAgentError(validated.subagentType, catalog.agents));
      }

      // Capability + model resolution happen BEFORE semaphore acquire.
      // Shared with Catalog doctor so execution and preflight cannot drift.
      // Never reads settings.subagents — Agent definition + Primary runtime only.
      const prepared = prepareAgentTaskOrThrow(agent, toPreparationRuntime(runtime));
      const tools = prepared.tools;
      // Primary runtime snapshot Warnings (e.g. trust) precede preparation Warnings.
      const warnings = dedupeWarnings([
        ...(runtime.warnings ?? []),
        ...prepared.warnings,
      ]);

      let phase: TaskPhase = "queued";
      let currentTool: TaskCurrentTool | undefined;
      // Internal correlation only. Public progress still exposes at most one
      // sanitized tool name/status and never exposes the call identity.
      const runningTools = new Map<string, TaskCurrentTool>();
      const tracker = createTimingTracker(clock);

      // Normalized capped result text retained for expanded rendering.
      let resultText: string | undefined;

      const detailsBase = (includeCurrentTool: boolean): TaskDetails => ({
        agent: prepared.agent.name,
        model: prepared.modelId,
        thinking: prepared.thinking,
        tools: [...tools],
        warnings: [...warnings],
        description: validated.description,
        subagentType: validated.subagentType,
        // Human-only: full prompt for expanded/resume views — never in progress text or XML.
        prompt: validated.prompt,
        phase,
        elapsedMs: tracker.elapsedMs(),
        ...(includeCurrentTool && currentTool ? { currentTool: { ...currentTool } } : {}),
        ...(resultText !== undefined ? { resultText } : {}),
      });

      const emit = () => {
        if (!onProgress) return;
        try {
          const toolPreview =
            phase === "running" && currentTool
              ? formatCurrentToolPreview(currentTool)
              : undefined;
          onProgress({
            text: formatPhaseProgressText({
              phase,
              agentName: prepared.agent.name,
              description: validated.description,
              toolPreview,
            }),
            // Partial progress may expose current tool; terminal omits it.
            details: detailsBase(phase === "queued" || phase === "running"),
          });
        } catch {
          // Progress is observational and must never alter Task lifecycle or cleanup.
        }
      };

      const onActivity = (event: ChildActivityEvent) => {
        if (event.type !== "tool") return;

        const observed: TaskCurrentTool = {
          toolName: event.toolName,
          status: event.status,
        };

        if (event.status === "running") {
          runningTools.set(event.toolCallId, observed);
          currentTool = observed;
        } else {
          runningTools.delete(event.toolCallId);
          // When parallel calls interleave, keep showing a tool that is still
          // running instead of replacing it with a completed sibling. If none
          // remain, expose this final status for the last progress snapshot.
          currentTool = lastRunningTool(runningTools) ?? observed;
        }
        emit();
      };

      let release: (() => void) | undefined;
      try {
        release = await semaphore.acquire(runtime.signal, () => {
          phase = "queued";
          // No queue counts retained — phase transition only.
          emit();
        });

        if (runtime.signal?.aborted) {
          phase = "aborted";
          currentTool = undefined;
          emit();
          throw abortError(`Task aborted: ${validated.description}`);
        }

        phase = "running";
        currentTool = undefined;
        emit();

        const outcome = await childSession.run({
          prompt: validated.prompt,
          agentBody: prepared.agent.body,
          tools,
          model: prepared.model,
          modelRegistry: runtime.modelRegistry!,
          thinking: prepared.thinking,
          cwd: runtime.cwd,
          projectTrusted: prepared.projectTrusted,
          signal: runtime.signal,
          onActivity,
        });

        warnings.push(...outcome.warnings);
        const prepWarnings = dedupeWarnings(warnings);

        // One normalization pass: sanitize → empty-check → soft-cap → XML.
        // resultText equals the logical <task_result> body.
        // Final details.warnings exactly match the warnings encoded in model XML.
        const normalized = normalizeSuccessResult({
          description: validated.description,
          text: outcome.text,
          warnings: prepWarnings,
        });

        resultText = normalized.resultText;
        const allWarnings = dedupeWarnings(normalized.warnings);
        // Keep detailsBase() warnings in sync with the packaged result.
        warnings.length = 0;
        warnings.push(...allWarnings);

        phase = "completed";
        currentTool = undefined;
        // Terminal completed notification is symmetric with failed/aborted.
        // A progress callback exception must not turn success into failure.
        try {
          emit();
        } catch {
          // progress must not mask success
        }
        return {
          text: normalized.modelXml,
          details: detailsBase(false),
        };
      } catch (err) {
        currentTool = undefined;
        if (isAbortError(err)) {
          phase = "aborted";
          try {
            emit();
          } catch {
            // progress must not mask abort
          }
          throw abortError(`Task aborted: ${validated.description}`);
        }
        phase = "failed";
        try {
          emit();
        } catch {
          // progress must not mask failure
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        release?.();
      }
    },
  };
}

export function validateTaskRequest(request: TaskRequest): {
  description: string;
  prompt: string;
  subagentType: string;
} {
  const description = typeof request.description === "string" ? request.description.trim() : "";
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const subagentType =
    typeof request.subagentType === "string" ? request.subagentType.trim() : "";

  if (!description) {
    throw new Error("Invalid task request: description is required and must be non-empty");
  }
  if (description.length > SUMMARY_MAX_CHARS) {
    throw new Error(
      `Invalid task request: description must be at most ${SUMMARY_MAX_CHARS} characters (got ${description.length})`,
    );
  }
  if (!prompt) {
    throw new Error("Invalid task request: prompt is required and must be non-empty");
  }
  if (!subagentType) {
    throw new Error("Invalid task request: subagent_type is required and must be non-empty");
  }

  return { description, prompt, subagentType };
}

function formatCurrentToolPreview(tool: TaskCurrentTool): string {
  const mark = tool.status === "running" ? "→" : tool.status === "error" ? "✗" : "✓";
  return `${mark} ${tool.toolName}`;
}

/** Return the most recently inserted tool that is still running. */
function lastRunningTool(
  tools: ReadonlyMap<string, TaskCurrentTool>,
): TaskCurrentTool | undefined {
  let latest: TaskCurrentTool | undefined;
  for (const tool of tools.values()) latest = tool;
  return latest;
}

// Re-export preparation types for extension / doctor integration.
export type { PreparedTask, TaskPreparationRuntime } from "./task-preparation.ts";
export { prepareAgentTask, prepareAgentTaskOrThrow } from "./task-preparation.ts";

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Classify only own abort errors (semaphore / child / task), which are named
 * `AbortError`. Do not match ordinary operational messages that merely contain
 * the substring "abort" (e.g. ECONNABORTED, "failed to abort transport").
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// Re-export AgentDefinition for consumers that need it
export type { AgentDefinition };
