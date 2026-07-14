/**
 * pi-task — OpenCode-inspired foreground subagent tool for pi.
 *
 * Registers parent-callable `task` tool. Discovers user agents from
 * ~/.pi/agent/agents/*.md and runs in-process child sessions.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createCatalogHolder,
  diagnosticFingerprint,
  type Diagnostic,
} from "./src/catalog.ts";
import {
  createChildSessionRunner,
  type SessionFactory,
} from "./src/child-session.ts";
import { createTaskExecutor } from "./src/task.ts";
import { isThinkingLevel, type PiThinkingLevel } from "./src/model.ts";
import { taskSemaphore } from "./src/semaphore.ts";
import { renderTaskCall, renderTaskResult } from "./src/task-renderer.ts";
import type { TaskDetails } from "./src/task.ts";
import {
  buildTaskToolContract,
  TASK_PARAMETER_DESCRIPTIONS,
} from "./src/task-contract.ts";

const TaskParams = Type.Object({
  description: Type.String({
    description: TASK_PARAMETER_DESCRIPTIONS.description,
  }),
  prompt: Type.String({
    description: TASK_PARAMETER_DESCRIPTIONS.prompt,
  }),
  subagent_type: Type.String({
    description: TASK_PARAMETER_DESCRIPTIONS.subagent_type,
  }),
});

export interface TaskExtensionOptions {
  /** Override agents directory (tests). Default: ~/.pi/agent/agents */
  agentsDir?: string;
  /** Inject session factory used to build the child runner (tests). */
  sessionFactory?: SessionFactory;
}

export function createTaskExtension(options: TaskExtensionOptions = {}) {
  return (pi: ExtensionAPI) => {
    const agentDir = getAgentDir();
    const agentsDir = options.agentsDir ?? path.join(agentDir, "agents");

    const catalog = createCatalogHolder(agentsDir);
    let lastEmittedFingerprint = "";

    const childSession = createChildSessionRunner(options.sessionFactory);

    const emitDiagnostics = (
      ctx: ExtensionContext | undefined,
      diagnostics: readonly Diagnostic[],
    ) => {
      if (diagnostics.length === 0) return;
      const fp = diagnosticFingerprint(diagnostics);
      if (fp === lastEmittedFingerprint) return;
      lastEmittedFingerprint = fp;

      const summary = diagnostics
        .slice(0, 5)
        .map((d) => (d.path ? `${d.message} (${d.path})` : d.message))
        .join("; ");
      const message =
        diagnostics.length > 5
          ? `pi-task: ${diagnostics.length} config diagnostics. ${summary}…`
          : `pi-task: ${summary}`;

      try {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(message, "warning");
        } else if (typeof console !== "undefined" && console.warn) {
          console.warn(message);
        }
      } catch {
        // ignore notify failures
      }
    };

    /**
     * The executor reports Catalog diagnostics synchronously during each Task.
     * Bind the invocation's context here rather than retaining a mutable current
     * context, so concurrent Tasks cannot send a notification to the wrong UI.
     */
    const createExecutor = (ctx: ExtensionContext) =>
      createTaskExecutor({
        catalog: () => catalog.get(),
        childSession,
        semaphore: taskSemaphore,
        diagnosticSink: (diagnostics) => emitDiagnostics(ctx, diagnostics),
      });

    const registerTool = () => {
      const snapshot = catalog.get();
      const contract = buildTaskToolContract(snapshot.agents);
      pi.registerTool({
        name: "task",
        label: "Task",
        description: contract.description,
        promptSnippet: contract.promptSnippet,
        promptGuidelines: [...contract.promptGuidelines],
        parameters: TaskParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          // Execute path is mode-agnostic: no terminal-only APIs.
          // Progress/details are structured for TUI renderers and plain for print/JSON/RPC.
          const runtime = buildTaskRuntime(ctx, pi, signal);
          const executor = createExecutor(ctx);

          const result = await executor.execute(
            {
              description: params.description,
              prompt: params.prompt,
              subagentType: params.subagent_type,
            },
            runtime,
            (progress) => {
              onUpdate?.({
                content: [{ type: "text", text: progress.text }],
                details: progress.details,
              });
            },
          );

          return {
            content: [{ type: "text", text: result.text }],
            details: result.details,
          };
        },
        // TUI presentation only — Pi does not invoke these in print/JSON/RPC.
        renderCall(args, theme) {
          return renderTaskCall(args, theme);
        },
        renderResult(result, options, theme, context) {
          return renderTaskResult(
            result as {
              content?: ReadonlyArray<{ type: string; text?: string }>;
              details?: TaskDetails;
              isError?: boolean;
            },
            options,
            theme,
            {
              isError: context?.isError,
              args: context?.args as
                | { description?: string; prompt?: string; subagent_type?: string }
                | undefined,
            },
          );
        },
      });
    };

    /**
     * Atomic Catalog refresh. Initial load is silent so the tool can register
     * immediately; each session_start reloads once and emits that reload's
     * diagnostics once through UI notify or stderr.
     */
    const refresh = (options?: {
      ctx?: ExtensionContext;
      emitDiagnostics?: boolean;
    }) => {
      const result = catalog.refresh();
      registerTool();
      if (options?.emitDiagnostics) {
        emitDiagnostics(options.ctx, result.diagnostics);
      }
      return result;
    };

    // Silent initial load: register the tool immediately without emitting diagnostics.
    refresh({ emitDiagnostics: false });

    // Rediscover agents and emit this reload's diagnostics once per session / reload.
    pi.on("session_start", (_event, ctx) => {
      lastEmittedFingerprint = "";
      refresh({ ctx, emitDiagnostics: true });
    });
  };
}

function buildTaskRuntime(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  signal?: AbortSignal,
) {
  let parentThinking: PiThinkingLevel | undefined;
  try {
    const level = pi.getThinkingLevel?.();
    if (typeof level === "string" && isThinkingLevel(level)) {
      parentThinking = level;
    }
  } catch {
    // getThinkingLevel may be unavailable in some contexts
  }

  // Fail closed when active-tool API is missing or throws: never masquerade as
  // a valid empty list (which would broaden or silently empty-intersect).
  const activeToolsSnapshot = resolveActiveTools(pi);

  const trust = resolveProjectTrust(ctx);

  return {
    cwd: ctx.cwd,
    parentModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
    parentThinking,
    activeTools: activeToolsSnapshot.activeTools,
    ...(activeToolsSnapshot.activeToolsApiFailed
      ? { activeToolsApiFailed: true as const }
      : {}),
    projectTrusted: trust.projectTrusted,
    ...(trust.warnings.length > 0 ? { warnings: trust.warnings } : {}),
    signal,
  };
}

/**
 * Resolve Parent active tools fail-closed.
 * Missing or throwing `getActiveTools` → API failure flag (preparation fails).
 * Successful call (including empty array) passes through unchanged.
 */
function resolveActiveTools(pi: ExtensionAPI): {
  activeTools: string[];
  activeToolsApiFailed: boolean;
} {
  if (typeof pi.getActiveTools !== "function") {
    return { activeTools: [], activeToolsApiFailed: true };
  }
  try {
    const tools = pi.getActiveTools();
    if (!Array.isArray(tools)) {
      return { activeTools: [], activeToolsApiFailed: true };
    }
    return {
      activeTools: tools.filter((t): t is string => typeof t === "string"),
      activeToolsApiFailed: false,
    };
  } catch {
    return { activeTools: [], activeToolsApiFailed: true };
  }
}

/** Approved fail-closed trust Warning (PI-TASK-001). */
const PROJECT_TRUST_UNAVAILABLE_WARNING =
  "Project trust unavailable; Child Session defaults to untrusted.";

/**
 * Resolve Parent project trust fail-closed.
 * Explicit true/false pass through; missing or throwing lookup → untrusted + Warning.
 */
function resolveProjectTrust(ctx: ExtensionContext): {
  projectTrusted: boolean;
  warnings: string[];
} {
  if (typeof ctx.isProjectTrusted !== "function") {
    return {
      projectTrusted: false,
      warnings: [PROJECT_TRUST_UNAVAILABLE_WARNING],
    };
  }
  try {
    return {
      projectTrusted: ctx.isProjectTrusted(),
      warnings: [],
    };
  } catch {
    return {
      projectTrusted: false,
      warnings: [PROJECT_TRUST_UNAVAILABLE_WARNING],
    };
  }
}

/** Default extension entry for pi auto-discovery / `pi -e`. */
export default createTaskExtension();
