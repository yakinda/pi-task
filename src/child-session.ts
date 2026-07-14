import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { finalAssistantText, type MessageLike } from "./result.ts";
import type { ModelRegistryLike, ParentModel, PiThinkingLevel } from "./model.ts";

export const FINAL_ANSWER_WRAPPER = `## Task result contract

You are a specialized subagent invoked by a parent agent via the \`task\` tool.

- Complete the assigned work autonomously.
- Return a **single concise final answer** as your last assistant message.
- The parent agent only receives that final text (not your tool transcripts).
- Do not dump raw tool outputs, intermediate reasoning dumps, or meta commentary about being a subagent.
- Prefer structured, scannable output when reporting findings.`;

/**
 * Activity status for child tool calls.
 * Keep `"error"` for compatibility; presentation may label it as failed.
 */
export type ActivityStatus = "running" | "completed" | "error";

/**
 * Sanitized Task-safe signals from Child Session.
 * Only tool identity + status cross the seam — never args, results, text, or reasoning.
 */
export type ChildActivityEvent = {
  type: "tool";
  toolCallId: string;
  toolName: string;
  status: ActivityStatus;
};

export interface ChildSessionInput {
  prompt: string;
  agentBody: string;
  tools: string[];
  model: ParentModel;
  modelRegistry: ModelRegistryLike;
  thinking?: PiThinkingLevel;
  cwd: string;
  projectTrusted: boolean;
  signal?: AbortSignal;
  onActivity?: (event: ChildActivityEvent) => void;
}

export interface ChildSessionOutcome {
  text: string;
  warnings: string[];
}

export interface ChildMessage {
  role: string;
  content?: Array<{ type: string; text?: string }> | string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PreparedChildSession {
  cwd: string;
  agentDir: string;
  tools: string[];
  model: ParentModel;
  modelRegistry: ModelRegistryLike;
  thinking?: PiThinkingLevel;
  projectTrusted: boolean;
  agentBody: string;
}

export interface SessionHandle {
  prompt(text: string, options: { expandPromptTemplates: false }): Promise<void>;
  subscribe(listener: (event: ChildSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  readonly messages: readonly ChildMessage[];
  /** Optional: real Pi sessions expose systemPrompt for integration tests. */
  readonly systemPrompt?: string;
}

/**
 * Normalized session events at the Child Session seam.
 * Streaming text/thinking deltas, tool args, and tool output bodies are never present.
 */
export type ChildSessionEvent =
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError?: boolean;
    };

export interface SessionFactory {
  create(input: PreparedChildSession): Promise<SessionHandle>;
}

export interface ChildSessionRunner {
  run(input: ChildSessionInput): Promise<ChildSessionOutcome>;
}

export function createChildSessionRunner(factory: SessionFactory = createPiSessionFactory()): ChildSessionRunner {
  return {
    async run(input: ChildSessionInput): Promise<ChildSessionOutcome> {
      const agentDir = getAgentDir();
      const prepared: PreparedChildSession = {
        cwd: input.cwd,
        agentDir,
        tools: input.tools,
        model: input.model,
        modelRegistry: input.modelRegistry,
        thinking: input.thinking,
        projectTrusted: input.projectTrusted,
        agentBody: input.agentBody,
      };

      let session: SessionHandle | undefined;
      let unsubscribe: (() => void) | undefined;
      let abortListener: (() => void) | undefined;
      const warnings: string[] = [];

      try {
        if (input.signal?.aborted) {
          throw abortError();
        }

        session = await factory.create(prepared);

        if (input.signal?.aborted) {
          throw abortError();
        }

        abortListener = () => {
          // Abort notification is best-effort; consume rejection so a provider's
          // abort failure cannot become an unhandled promise rejection.
          void session?.abort().catch(() => {});
        };
        if (input.signal) {
          input.signal.addEventListener("abort", abortListener, { once: true });
        }

        unsubscribe = session.subscribe((event) => {
          if (!input.onActivity) return;
          if (event.type === "tool_execution_start") {
            input.onActivity({
              type: "tool",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: "running",
            });
          } else if (event.type === "tool_execution_end") {
            input.onActivity({
              type: "tool",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? "error" : "completed",
            });
          }
        });

        await session.prompt(input.prompt, { expandPromptTemplates: false });

        if (input.signal?.aborted) {
          throw abortError();
        }

        return interpretOutcome(session.messages as MessageLike[], warnings);
      } finally {
        // Cleanup always runs; failures do not overwrite primary outcome
        try {
          if (input.signal && abortListener) {
            input.signal.removeEventListener("abort", abortListener);
          }
        } catch {
          // ignore
        }
        try {
          unsubscribe?.();
        } catch {
          // ignore
        }
        try {
          if (session) {
            // Best-effort abort if still streaming, then dispose
            try {
              await session.abort();
            } catch {
              // ignore abort during cleanup
            }
            session.dispose();
          }
        } catch {
          // Cleanup failure must not overwrite primary result/error
        }
      }
    },
  };
}

/**
 * Map final assistant message stop reason → text/warnings or throw.
 * Only inspects the last assistant message (no reverse scan for older text).
 */
export function interpretOutcome(
  messages: readonly MessageLike[],
  warnings: string[] = [],
): ChildSessionOutcome {
  const final = finalAssistantText(messages);

  if (!final.found) {
    throw new Error("Task failed: child session produced no assistant message");
  }

  const stop = final.stopReason;

  if (stop === "error") {
    throw new Error(
      final.errorMessage?.trim()
        ? `Task failed: ${final.errorMessage}`
        : "Task failed: provider returned stopReason=error",
    );
  }

  if (stop === "aborted") {
    throw abortError("Task aborted: child session was aborted");
  }

  if (stop === "toolUse") {
    throw new Error(
      "Task failed: child ended on a tool-only assistant turn without a final answer",
    );
  }

  if (stop !== undefined && stop !== "stop" && stop !== "length") {
    throw new Error(`Task failed: unexpected child stopReason "${stop}"`);
  }

  if (!final.text.trim()) {
    throw new Error("Task failed: child produced empty final assistant text");
  }

  if (stop === "length") {
    warnings.push("Child result may be incomplete (stopReason=length)");
  }

  return { text: final.text, warnings: [...warnings] };
}

export function buildSpecialistSystemPrompt(agentBody: string): string {
  const body = agentBody.trim();
  const wrapper = FINAL_ANSWER_WRAPPER.trim();
  return body ? `${body}\n\n${wrapper}` : wrapper;
}

/**
 * Production SessionFactory: wraps Pi `createAgentSession` with parent registry/auth,
 * trust inheritance, and hermetic resource assembly (no ambient specialist resources).
 */
export function createPiSessionFactory(): SessionFactory {
  return {
    async create(input: PreparedChildSession): Promise<SessionHandle> {
      const settingsManager = SettingsManager.create(input.cwd, input.agentDir, {
        projectTrusted: input.projectTrusted,
      });

      const specialistPrompt = buildSpecialistSystemPrompt(input.agentBody);
      const resourceLoader = createChildResourceLoader(input, settingsManager);
      await resourceLoader.reload();

      // Parent model registry is shared; never create independent AuthStorage/ModelRegistry
      const modelRegistry = input.modelRegistry as ModelRegistry;

      const sessionOpts: Parameters<typeof createAgentSession>[0] = {
        cwd: input.cwd,
        agentDir: input.agentDir,
        modelRegistry,
        model: input.model,
        tools: input.tools,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(input.cwd),
      };
      if (input.thinking) {
        sessionOpts.thinkingLevel = input.thinking;
      }

      const { session } = await createAgentSession(sessionOpts);

      // Pi's buildSystemPrompt always appends date/cwd (and can re-append ambient
      // context). Force the exact specialist role after session construction so the
      // Child system prompt is only Agent body + fixed final-answer contract.
      forceSpecialistSystemPrompt(session, specialistPrompt);

      return {
        prompt: (text, options) => session.prompt(text, options),
        subscribe: (listener) =>
          session.subscribe((event) => {
            // Explicitly sanitize: never forward streaming text/thinking deltas,
            // tool args, tool_execution_update partial results, or tool output bodies.
            if (event.type === "tool_execution_start") {
              listener({
                type: "tool_execution_start",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
            } else if (event.type === "tool_execution_end") {
              listener({
                type: "tool_execution_end",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                // result intentionally omitted — tool output bodies never leave this seam
              });
            }
            // All other event types (message_*, tool_execution_update, agent_*, turn_*, etc.) discarded
          }),
        abort: () => session.abort(),
        dispose: () => session.dispose(),
        get messages() {
          return session.messages as ChildMessage[];
        },
        get systemPrompt() {
          return session.systemPrompt;
        },
      };
    },
  };
}

/**
 * Build a hermetic Child Session resource loader.
 * Disables extensions, Skills, project context files, prompt templates, themes,
 * and appended system-prompt resources. Specialist role is Agent body + contract only.
 */
export function createChildResourceLoader(
  input: Pick<PreparedChildSession, "cwd" | "agentDir" | "agentBody">,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  const specialistPrompt = buildSpecialistSystemPrompt(input.agentBody);

  return new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => specialistPrompt,
    appendSystemPromptOverride: () => [],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
}

/**
 * Pin the session's effective system prompt to the exact specialist role.
 * Also rewrites the private base prompt so later rebuilds do not reintroduce ambient context.
 */
export function forceSpecialistSystemPrompt(
  session: { agent: { state: { systemPrompt: string } }; systemPrompt?: string },
  specialistPrompt: string,
): void {
  session.agent.state.systemPrompt = specialistPrompt;
  // AgentSession keeps a private base prompt used on rebuild/tool changes.
  const mutable = session as unknown as { _baseSystemPrompt?: string };
  if (mutable && typeof mutable === "object") {
    mutable._baseSystemPrompt = specialistPrompt;
  }
}

function abortError(message = "Aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}
