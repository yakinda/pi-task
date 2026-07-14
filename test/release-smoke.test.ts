/**
 * Integrated release smoke (deterministic, no live provider).
 *
 * Focused coverage for the simplified runtime: concurrency, progress isolation,
 * rendering, abort cleanup, dual-channel results, Catalog reload, package identity.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskExtension } from "../index.ts";
import { loadAgentCatalog } from "../src/catalog.ts";
import {
  createChildSessionRunner,
  type ChildSessionRunner,
  type SessionFactory,
  type SessionHandle,
} from "../src/child-session.ts";
import type { ModelRegistryLike, ParentModel } from "../src/model.ts";
import {
  codePointLength,
  RESULT_SOFT_CAP,
  TRUNCATION_MARKER_NEEDLE,
} from "../src/result.ts";
import { Semaphore } from "../src/semaphore.ts";
import {
  createTaskExecutor,
  type TaskDetails,
  type TaskProgress,
} from "../src/task.ts";
import { renderTaskCall, renderTaskResult } from "../src/task-renderer.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeModel(provider = "xai", id = "m1"): ParentModel {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as ParentModel;
}

function registry(model: ParentModel = fakeModel()): ModelRegistryLike {
  return {
    find: (p, id) => (p === model.provider && id === model.id ? model : undefined),
    hasConfiguredAuth: (m) => m.provider === model.provider && m.id === model.id,
  };
}

function writeAgent(
  dir: string,
  name: string,
  body: {
    description?: string;
    tools?: string;
    thinking?: string;
    model?: string;
    content?: string;
  } = {},
): void {
  const toolsLine = body.tools ? `tools: ${body.tools}\n` : "";
  const thinkingLine = body.thinking ? `thinking: ${body.thinking}\n` : "";
  const modelLine = body.model ? `model: ${body.model}\n` : "";
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---
name: ${name}
description: ${body.description ?? `${name} agent`}
${toolsLine}${thinkingLine}${modelLine}---
${body.content ?? `You are ${name}.`}
`,
  );
}

function baseRuntime(over: {
  signal?: AbortSignal;
  activeTools?: string[];
  parentThinking?: "low" | "medium" | "high";
} = {}) {
  const model = fakeModel();
  return {
    cwd: "/repo",
    parentModel: model,
    modelRegistry: registry(model),
    parentThinking: over.parentThinking ?? ("medium" as const),
    activeTools: over.activeTools ?? ["read", "bash", "grep", "find", "ls", "edit", "write"],
    projectTrusted: true,
    signal: over.signal,
  };
}

/** Identity theme — semantic assertions only (no ANSI snapshots). */
const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};

function plain(component: { render: (width: number) => string[] }): string {
  return component
    .render(200)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+$/gm, "");
}

function extractTaskResultCdata(xml: string): string {
  const m = xml.match(/<task_result>([\s\S]*)<\/task_result>/);
  if (!m) throw new Error("missing task_result");
  // Strip CDATA wrappers for size checks of the model-visible raw result channel.
  return m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
}

describe("Issue 13 — release smoke (deterministic, no provider)", () => {
  it("1. five concurrent Tasks with max=4: fifth queues with pressure then runs", async () => {
    const agentsDir = tempDir("pi-task-smoke-q-");
    writeAgent(agentsDir, "explore", { tools: "read", thinking: "low" });
    const catalog = loadAgentCatalog(agentsDir);
    const sem = new Semaphore(4);

    const holdGates: Array<() => void> = [];
    const hold = () =>
      new Promise<void>((resolve) => {
        holdGates.push(resolve);
      });

    let childStarts = 0;
    const child: ChildSessionRunner = {
      async run() {
        childStarts += 1;
        await hold();
        return { text: `ok-${childStarts}`, warnings: [] };
      },
    };

    const executor = createTaskExecutor({
      catalog: () => catalog,

      semaphore: sem,
      childSession: child,
    });

    const runtime = baseRuntime({ activeTools: ["read"] });
    const progressByTask: TaskProgress[][] = Array.from({ length: 5 }, () => []);

    const tasks = Array.from({ length: 5 }, (_, i) =>
      executor.execute(
        { description: `job-${i}`, prompt: `p${i}`, subagentType: "explore" },
        runtime,
        (p) => progressByTask[i].push(p),
      ),
    );

    // Wait until 4 children are inside run() and the fifth is queued.
    for (
      let i = 0;
      i < 200 &&
      !(childStarts === 4 && sem.activeCount === 4 && sem.waitingCount === 1);
      i++
    ) {
      await Promise.resolve();
    }
    expect(sem.activeCount).toBe(4);
    expect(sem.waitingCount).toBe(1);
    expect(childStarts).toBe(4);

    // Fifth must have emitted queued phase (no queue counts retained), not running yet.
    const fifthQueued = progressByTask[4].filter((p) => p.details.phase === "queued");
    expect(fifthQueued.length).toBeGreaterThanOrEqual(1);
    expect(fifthQueued[0].details).not.toHaveProperty("queue");
    expect(fifthQueued[0].text).toMatch(/Queued/i);
    expect(fifthQueued[0].text).not.toMatch(/active=|waiting=/);
    expect(progressByTask[4].some((p) => p.details.phase === "running")).toBe(false);

    // Release one slot → fifth runs and completes.
    holdGates.shift()?.();
    for (let i = 0; i < 200 && childStarts < 5; i++) await Promise.resolve();
    expect(childStarts).toBe(5);
    expect(progressByTask[4].some((p) => p.details.phase === "running")).toBe(true);

    for (const release of holdGates.splice(0)) release();
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.details.phase === "completed")).toBe(true);
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("2. tool progress shows name/status only; child text/thinking absent from progress/details/model context", async () => {
    const agentsDir = tempDir("pi-task-smoke-hb-");
    writeAgent(agentsDir, "explore", { tools: "read" });
    const catalog = loadAgentCatalog(agentsDir);
    const secretText = "SECRET_CHILD_ANSWER_STREAM_XYZ";
    const secretThink = "SECRET_HIDDEN_THINKING_ABC";

    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalog,
      semaphore: new Semaphore(4),
      childSession: {
        async run(input) {
          input.onActivity?.({
            type: "tool",
            toolCallId: "c1",
            toolName: "read",
            status: "running",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "c1",
            toolName: "read",
            status: "completed",
          });
          return {
            text: "public final answer",
            warnings: [],
          };
        },
      },
    });

    const result = await executor.execute(
      {
        description: "tool-progress-smoke",
        prompt: `ignore ${secretText} and ${secretThink}`,
        subagentType: "explore",
      },
      baseRuntime({ activeTools: ["read"] }),
      (p) => progress.push(p),
    );

    const toolProgress = progress.filter(
      (p) => p.details.phase === "running" && p.details.currentTool,
    );
    expect(toolProgress.length).toBeGreaterThanOrEqual(1);

    for (const p of progress) {
      // Progress *text* is model-adjacent and must not leak secrets.
      // Human-only details.prompt intentionally retains the full delegated prompt.
      expect(p.text).not.toContain(secretText);
      expect(p.text).not.toContain(secretThink);
      expect(p.details).not.toHaveProperty("activity");
      if (p.details.currentTool) {
        expect(p.details.currentTool).not.toHaveProperty("args");
        expect(p.details.currentTool).not.toHaveProperty("toolCallId");
        expect(p.details.currentTool.toolName).toBe("read");
        expect(JSON.stringify(p.details.currentTool)).not.toContain(secretText);
        expect(JSON.stringify(p.details.currentTool)).not.toContain(secretThink);
      }
    }

    expect(result.text).toContain("public final answer");
    expect(result.text).not.toContain(secretText);
    expect(result.text).not.toContain(secretThink);
    expect(result.details).not.toHaveProperty("activity");
    expect(result.details).not.toHaveProperty("currentTool");
  });

  it("3. effective config, timing, Warnings, and result render collapsed/expanded", async () => {
    const agentsDir = tempDir("pi-task-smoke-render-");
    writeAgent(agentsDir, "explore", {
      tools: "read, write, task",
      thinking: "low",
    });
    const catalog = loadAgentCatalog(agentsDir);
    const clock = (() => {
      let now = 5_000_000;
      return {
        now: () => now,
        advance(ms: number) {
          now += ms;
        },
      };
    })();

    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalog,

      semaphore: new Semaphore(4),
      clock: () => clock.now(),
      childSession: {
        async run(input) {
          clock.advance(15); // queue not used; execution timing
          input.onActivity?.({
            type: "tool",
            toolCallId: "c1",
            toolName: "read",
            status: "running",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "c1",
            toolName: "read",
            status: "completed",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "c2",
            toolName: "grep",
            status: "running",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "c2",
            toolName: "grep",
            status: "error",
          });
          clock.advance(40);
          return {
            text: "## Findings\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```",
            warnings: ["Child result may be incomplete (stopReason=length)"],
          };
        },
      },
    });

    const longPrompt =
      "Investigate authentication thoroughly and list every token issuance call site with file paths.";
    const result = await executor.execute(
      { description: "multi-turn", prompt: longPrompt, subagentType: "explore" },
      baseRuntime({ activeTools: ["read", "bash", "grep"], parentThinking: "high" }),
      (p) => progress.push(p),
    );

    // Effective config + capability reductions
    expect(result.details.model).toBe("xai/m1");
    expect(result.details).not.toHaveProperty("modelSource");
    expect(result.details.thinking).toBe("low");
    // Agent allowlist is read/write/task; parent active is read/bash/grep → only read survives.
    // write is inactive on parent; task is always removed; grep was never requested by the agent.
    expect(result.details.tools).toEqual(["read"]);
    expect(result.details.warnings.some((w) => /write|task|length/i.test(w))).toBe(true);
    expect(result.details).not.toHaveProperty("usage");
    expect(typeof result.details.elapsedMs).toBe("number");
    expect(result.details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.details).not.toHaveProperty("timing");
    expect(result.details).not.toHaveProperty("activity");
    expect(result.details).not.toHaveProperty("currentTool");
    expect(result.details.prompt).toBe(longPrompt);
    expect(result.details.resultText).toContain("## Findings");
    // Final details warnings exactly match model-facing success XML warnings
    // (XML escapes quotes; decode for logical equality with details strings).
    const xmlWarnings = [...result.text.matchAll(/<warning>([^<]*)<\/warning>/g)].map((m) =>
      m[1]!
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    expect(result.details.warnings).toEqual(xmlWarnings);

    // Collapsed call: agent + description + bounded prompt preview (not full prompt)
    const call = plain(
      renderTaskCall(
        {
          description: "multi-turn",
          prompt: longPrompt,
          subagent_type: "explore",
        },
        theme,
      ),
    );
    expect(call).toMatch(/explore/);
    expect(call).toMatch(/multi-turn/);
    expect(call).not.toContain(longPrompt);

    // Collapsed completed summary
    const collapsed = plain(
      renderTaskResult(
        { content: [{ type: "text", text: result.text }], details: result.details },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    expect(collapsed.toLowerCase()).toMatch(/completed|explore/);
    expect(collapsed).toMatch(/warn/i);

    // Expanded run report
    const expanded = plain(
      renderTaskResult(
        { content: [{ type: "text", text: result.text }], details: result.details },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(expanded).toContain(longPrompt);
    expect(expanded).toMatch(/xai\/m1/);
    expect(expanded).toMatch(/low/);
    expect(expanded).not.toMatch(/\(parent\)|modelSource|startedAt/i);
    expect(expanded).toMatch(/read/);
    expect(expanded).toMatch(/Findings|item one/);
    expect(expanded).not.toMatch(/cacheRead|0\.0123|contextTokens/i);
  });

  it("4. queued abort and active abort leave no orphan Child Session/listeners and release slots", async () => {
    const agentsDir = tempDir("pi-task-smoke-abort-");
    writeAgent(agentsDir, "explore", { tools: "read" });
    const catalog = loadAgentCatalog(agentsDir);
    const sem = new Semaphore(1);

    // --- Queued abort ---
    const holdRelease = await sem.acquire();
    let queuedChildStarts = 0;
    const queuedProgress: TaskProgress[] = [];
    const queuedAc = new AbortController();
    const queuedExec = createTaskExecutor({
      catalog: () => catalog,

      semaphore: sem,
      childSession: {
        async run() {
          queuedChildStarts += 1;
          return { text: "no", warnings: [] };
        },
      },
    });
    const queuedP = queuedExec.execute(
      { description: "queued-abort", prompt: "p", subagentType: "explore" },
      baseRuntime({ signal: queuedAc.signal, activeTools: ["read"] }),
      (p) => queuedProgress.push(p),
    );
    for (let i = 0; i < 40 && !queuedProgress.some((p) => p.details.phase === "queued"); i++) {
      await Promise.resolve();
    }
    expect(queuedProgress.some((p) => p.details.phase === "queued")).toBe(true);
    queuedAc.abort();
    await expect(queuedP).rejects.toThrow(/abort/i);
    expect(queuedChildStarts).toBe(0);
    expect(sem.waitingCount).toBe(0);
    expect(sem.activeCount).toBe(1); // only the hold
    holdRelease();
    expect(sem.activeCount).toBe(0);

    // --- Active abort through real ChildSessionRunner + fake SessionFactory ---
    // Pattern matches child-session tests: prompt observes abort, throws AbortError;
    // runner finally unsubscribes, aborts, and disposes.
    let disposeCount = 0;
    let abortCount = 0;
    let unsubscribeCount = 0;
    let listenerCount = 0;
    let promptEntered: () => void;
    const promptGate = new Promise<void>((resolve) => {
      promptEntered = resolve;
    });

    const factory: SessionFactory = {
      async create() {
        let rejectPrompt: ((err: Error) => void) | undefined;
        const handle: SessionHandle = {
          async prompt() {
            promptEntered();
            await new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
            });
          },
          subscribe(_listener) {
            listenerCount += 1;
            return () => {
              listenerCount -= 1;
              unsubscribeCount += 1;
            };
          },
          async abort() {
            abortCount += 1;
            if (rejectPrompt) {
              const err = new Error("Aborted");
              err.name = "AbortError";
              rejectPrompt(err);
            }
          },
          dispose() {
            disposeCount += 1;
          },
          messages: [],
        };
        return handle;
      },
    };

    const activeSem = new Semaphore(4);
    const runner = createChildSessionRunner(factory);
    const activeAc = new AbortController();
    const activeProgress: TaskProgress[] = [];
    let removeListenerCount = 0;
    const originalRemove = activeAc.signal.removeEventListener.bind(activeAc.signal);
    activeAc.signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if (type === "abort") removeListenerCount += 1;
      return originalRemove(
        type,
        listener as Parameters<AbortSignal["removeEventListener"]>[1],
        options as Parameters<AbortSignal["removeEventListener"]>[2],
      );
    }) as typeof activeAc.signal.removeEventListener;

    const activeExec = createTaskExecutor({
      catalog: () => catalog,

      semaphore: activeSem,
      childSession: runner,
    });

    const activeP = activeExec.execute(
      { description: "active-abort", prompt: "p", subagentType: "explore" },
      baseRuntime({ signal: activeAc.signal, activeTools: ["read"] }),
      (p) => activeProgress.push(p),
    );

    await promptGate;
    for (let i = 0; i < 40 && !activeProgress.some((p) => p.details.phase === "running"); i++) {
      await Promise.resolve();
    }
    expect(activeProgress.some((p) => p.details.phase === "running")).toBe(true);
    expect(activeSem.activeCount).toBe(1);

    activeAc.abort();
    await expect(activeP).rejects.toThrow(/abort/i);

    // Child Session ownership: abort + unsubscribe + dispose ran; slot free; no orphan listeners.
    expect(abortCount).toBeGreaterThanOrEqual(1);
    expect(unsubscribeCount).toBe(1);
    expect(disposeCount).toBe(1);
    expect(listenerCount).toBe(0);
    expect(removeListenerCount).toBeGreaterThanOrEqual(1);
    expect(activeSem.activeCount).toBe(0);
    expect(activeSem.waitingCount).toBe(0);
    expect(activeProgress.some((p) => p.details.phase === "aborted")).toBe(true);
  });

  it("5. >8,000 code-point results: one capped channel, equal model/human text, no artifacts", async () => {
    const agentsDir = tempDir("pi-task-smoke-result-");
    writeAgent(agentsDir, "explore", { tools: "read" });
    const catalog = loadAgentCatalog(agentsDir);

    // Soft-cap path: >8000 multi-byte code points
    const overCap = "α".repeat(RESULT_SOFT_CAP + 200);
    expect(codePointLength(overCap)).toBeGreaterThan(RESULT_SOFT_CAP);

    const executorCap = createTaskExecutor({
      catalog: () => catalog,
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: overCap, warnings: [] };
        },
      },
    });
    const capResult = await executorCap.execute(
      { description: "cap", prompt: "p", subagentType: "explore" },
      baseRuntime({ activeTools: ["read"] }),
    );

    expect(capResult.text).toMatch(/<task state="completed">/);
    expect(capResult.text).toContain(TRUNCATION_MARKER_NEEDLE);
    const raw = extractTaskResultCdata(capResult.text);
    expect(codePointLength(raw)).toBeLessThanOrEqual(RESULT_SOFT_CAP);
    // Equality contract: details.resultText === XML logical content
    expect(capResult.details.resultText).toBe(raw);
    expect(capResult.details).not.toHaveProperty("resultRetention");
    expect(capResult.details).not.toHaveProperty("resultTruncation");
    expect(capResult.details).not.toHaveProperty("resultArtifact");
    expect(capResult.details.warnings.some((w) => /truncated/i.test(w))).toBe(true);
    expect(capResult.details.warnings.some((w) => /artifact/i.test(w))).toBe(false);

    // Expanded render shows capped result, no artifact UI
    const expanded = plain(
      renderTaskResult(
        { content: [{ type: "text", text: capResult.text }], details: capResult.details },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(expanded).toContain("─── Result ───");
    expect(expanded).toContain(raw.slice(0, 40));
    expect(expanded.toLowerCase()).not.toMatch(/artifact:/);
    expect(expanded).not.toContain("─── Truncation ───");

    // Larger body still uses the same single 8k soft-cap (no 50 KiB human tier)
    const huge = "B".repeat(60_000);
    const executorHuge = createTaskExecutor({
      catalog: () => catalog,
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: huge, warnings: [] };
        },
      },
    });
    const hugeResult = await executorHuge.execute(
      { description: "huge", prompt: "p", subagentType: "explore" },
      baseRuntime({ activeTools: ["read"] }),
    );
    expect(hugeResult.details).not.toHaveProperty("resultRetention");
    expect(hugeResult.details).not.toHaveProperty("resultArtifact");
    expect(codePointLength(extractTaskResultCdata(hugeResult.text))).toBeLessThanOrEqual(
      RESULT_SOFT_CAP,
    );
    expect(hugeResult.details.resultText).toBe(extractTaskResultCdata(hugeResult.text));
    expect(hugeResult.details.resultText!.length).toBeLessThan(huge.length);

    // Concurrent Tasks remain independent with equal channels
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createTaskExecutor({
          catalog: () => catalog,
          semaphore: new Semaphore(4),
          childSession: {
            async run() {
              return {
                text: `${overCap}-c${i}`,
                warnings: [],
              };
            },
          },
        }).execute(
          { description: `c-${i}`, prompt: "p", subagentType: "explore" },
          baseRuntime({ activeTools: ["read"] }),
        ),
      ),
    );
    for (const r of concurrent) {
      expect(r.details.resultText).toBe(extractTaskResultCdata(r.text));
      expect(r.details).not.toHaveProperty("resultArtifact");
      expect(codePointLength(r.details.resultText!)).toBeLessThanOrEqual(RESULT_SOFT_CAP);
    }
  });

  it("6. Catalog load/reload and extension registration work without Child Session/provider calls", async () => {
    const agentsDir = tempDir("pi-task-smoke-cat-");
    writeAgent(agentsDir, "explore", { tools: "read, grep", thinking: "low" });
    writeAgent(agentsDir, "reviewer", {
      tools: "read",
      thinking: "medium",
      description: "Review specialist",
    });

    const { createCatalogHolder } = await import("../src/catalog.ts");
    const holder = createCatalogHolder(agentsDir);
    const snap1 = holder.refresh();
    expect(snap1.fatal).toBe(false);
    expect(snap1.swapped).toBe(true);
    expect(snap1.snapshot.agents.map((a) => a.name).sort()).toEqual(["explore", "reviewer"]);
    expect(snap1.snapshot.find("EXPLORE")?.name).toBe("explore");

    // Edit + refresh atomically
    writeAgent(agentsDir, "general", {
      description: "Generalist",
      thinking: "medium",
    });
    const snap2 = holder.refresh();
    expect(snap2.swapped).toBe(true);
    expect(holder.get().agents.map((a) => a.name).sort()).toEqual([
      "explore",
      "general",
      "reviewer",
    ]);

    // Extension public surface: one task tool, no commands
    let childStarts = 0;
    const initAgents = tempDir("pi-task-smoke-init-");
    writeAgent(initAgents, "explore", { tools: "read", description: "Fast search" });
    const { pi } = mockExtensionPi();
    createTaskExtension({
      agentsDir: initAgents,
      sessionFactory: {
        async create() {
          childStarts += 1;
          return {
            async prompt() {},
            subscribe() {
              return () => {};
            },
            async abort() {},
            dispose() {},
            messages: [],
          };
        },
      },
    })(pi as any);

    expect([...pi._tools.keys()]).toEqual(["task"]);
    expect(pi._commands.size).toBe(0);
    expect(pi._tools.get("task").description).toContain("explore: Fast search");
    expect(childStarts).toBe(0);
  });

  it("7–8. package seams: TaskExecutor entry, Child Session ownership, additive details, minimal exports", async () => {
    // Public surface is only default + createTaskExtension + TaskExtensionOptions.
    const mod = await import("../index.ts");
    const keys = Object.keys(mod).sort();
    expect(keys).toEqual(["createTaskExtension", "default"].sort());
    expect(typeof mod.createTaskExtension).toBe("function");
    expect(typeof mod.default).toBe("function");

    // TaskExecutor remains the execution seam (extension uses it; we call it directly).
    const agentsDir = tempDir("pi-task-smoke-seam-");
    writeAgent(agentsDir, "explore", { tools: "read" });
    const catalog = loadAgentCatalog(agentsDir);

    let disposeCount = 0;
    let unsubscribeCount = 0;
    const factory: SessionFactory = {
      async create() {
        return {
          async prompt() {
            /* resolve immediately with empty; interpretOutcome needs assistant */
          },
          subscribe() {
            return () => {
              unsubscribeCount += 1;
            };
          },
          async abort() {},
          dispose() {
            disposeCount += 1;
          },
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "seam-ok" }],
              stopReason: "stop",
            },
          ],
        };
      },
    };

    const executor = createTaskExecutor({
      catalog: () => catalog,

      semaphore: new Semaphore(4),
      childSession: createChildSessionRunner(factory),
    });

    const result = await executor.execute(
      { description: "seam", prompt: "p", subagentType: "explore" },
      baseRuntime({ activeTools: ["read"] }),
    );

    // Success XML + additive details
    expect(result.text).toMatch(/<task state="completed">/);
    expect(result.text).toContain("seam-ok");
    const details: TaskDetails = result.details;
    expect(details.phase).toBe("completed");
    expect(typeof details.elapsedMs).toBe("number");
    expect(details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(details).not.toHaveProperty("timing");
    expect(details).not.toHaveProperty("modelSource");
    expect(details).not.toHaveProperty("usage");
    expect(details.prompt).toBe("p");
    expect(details.resultText).toBe("seam-ok");
    expect(details.agent).toBe("explore");
    expect(details.tools).toEqual(["read"]);
    expect(Array.isArray(details.warnings)).toBe(true);
    expect(details).not.toHaveProperty("activity");
    expect(details).not.toHaveProperty("droppedActivityCount");

    // Child Session finally path cleaned up
    expect(unsubscribeCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  it("9–10. hardened invariants still hold on the integrated path (no escalation / trust / XML)", async () => {
    const agentsDir = tempDir("pi-task-smoke-inv-");
    writeAgent(agentsDir, "explore", {
      tools: "read, write, task, custom_ext",
      thinking: "low",
    });
    const catalog = loadAgentCatalog(agentsDir);
    let sawTools: string[] | undefined;
    let sawTrusted: boolean | undefined;

    const executor = createTaskExecutor({
      catalog: () => catalog,

      semaphore: new Semaphore(4),
      childSession: {
        async run(input) {
          sawTools = [...input.tools];
          sawTrusted = input.projectTrusted;
          return {
            text: "ok <tag> & ]]> done",
            warnings: [],
          };
        },
      },
    });

    const result = await executor.execute(
      { description: "invariants", prompt: "p", subagentType: "explore" },
      {
        ...baseRuntime({ activeTools: ["read", "bash"] }),
        projectTrusted: false,
      },
    );

    // No escalation: only parent-active built-ins; task + custom removed
    expect(sawTools).toEqual(["read"]);
    expect(sawTrusted).toBe(false);
    expect(result.details.tools).toEqual(["read"]);
    expect(result.details.warnings.some((w) => /task/i.test(w))).toBe(true);

    // Valid XML with hostile content
    expect(result.text).toMatch(/<task state="completed">/);
    expect(result.text).toContain("<![CDATA[");
    expect(result.text).toMatch(/<\/task>/);

    // Operational failure still throws (not error XML)
    await expect(
      executor.execute(
        { description: "bad", prompt: "p", subagentType: "missing-agent" },
        baseRuntime({ activeTools: ["read"] }),
      ),
    ).rejects.toThrow(/unknown|not found|available/i);
  });
});

function mockExtensionPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const logs: string[] = [];
  const notifies: Array<{ message: string; type?: string }> = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  afterEach(() => {
    console.log = originalLog;
  });
  const pi = {
    registerTool: (def: any) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, def: any) => {
      commands.set(name, { name, ...def });
    },
    on: (event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["read", "bash", "grep", "find", "ls"],
    _tools: tools,
    _commands: commands,
    _handlers: handlers,
    _notifies: notifies,
  };
  return { pi, logs, notifies };
}

describe("PI-TASK-002 — local package release identity", () => {
  it("declares package version 0.3.0", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    expect(pkg.version).toBe("0.3.0");
  });

  it("declares engines Node 22 or newer", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBeDefined();
    // Accept common Node 22+ forms: ">=22", ">=22.0.0", ">=22 <25", etc.
    expect(pkg.engines!.node).toMatch(/(^|\s)(>=|>)\s*22(\b|\.0)/);
    expect(pkg.engines!.node).not.toMatch(/\b1[68]\b/);
  });

  it("root package export resolves to the Pi extension entry", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      exports?: string | Record<string, unknown>;
      main?: string;
      pi?: { extensions?: string[] };
    };
    const piEntry = pkg.pi?.extensions?.[0];
    expect(piEntry).toBeTruthy();
    expect(fs.existsSync(path.resolve(process.cwd(), piEntry!))).toBe(true);

    let rootExport: string | undefined;
    if (typeof pkg.exports === "string") {
      rootExport = pkg.exports;
    } else if (pkg.exports && typeof pkg.exports["."] === "string") {
      rootExport = pkg.exports["."] as string;
    } else if (
      pkg.exports &&
      pkg.exports["."] &&
      typeof pkg.exports["."] === "object" &&
      typeof (pkg.exports["."] as { import?: string }).import === "string"
    ) {
      rootExport = (pkg.exports["."] as { import: string }).import;
    } else {
      rootExport = pkg.main;
    }
    expect(rootExport).toBeTruthy();
    // Normalize "./index.ts" vs "index.ts"
    const norm = (s: string) => s.replace(/^\.\//, "");
    expect(norm(rootExport!)).toBe(norm(piEntry!));
  });

  it("keeps Pi-provided runtime libraries as peerDependency *", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    const peers = pkg.peerDependencies ?? {};
    for (const name of [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      expect(peers[name], name).toBe("*");
    }
  });

  it("does not declare repository, homepage, or bugs URLs", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.repository).toBeUndefined();
    expect(pkg.homepage).toBeUndefined();
    expect(pkg.bugs).toBeUndefined();
  });

  it("pack dry-run ships runtime assets and CHANGELOG only (no historical ADRs)", async () => {
    const { execFileSync } = await import("node:child_process");
    const raw = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const parsed = JSON.parse(raw) as Array<{ files?: Array<string | { path?: string; name?: string }> }> | {
      files?: Array<string | { path?: string; name?: string }>;
    };
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = (entry?.files ?? []).map((f) =>
      typeof f === "string" ? f : (f.path ?? f.name ?? ""),
    );
    expect(files).toContain("package.json");
    expect(files).toContain("index.ts");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("src/task.ts");
    expect(files).toContain("src/catalog.ts");
    // CHANGELOG, CONTEXT, starters, historical docs must not ship.
    expect(files).not.toContain("CHANGELOG.md");
    expect(files).not.toContain("CONTEXT.md");
    expect(files.some((f) => f.startsWith("starters/") || f === "starters")).toBe(false);
    expect(files.some((f) => f.startsWith("docs/adr/") || f === "docs/adr")).toBe(false);
    expect(files).not.toContain("docs/RELEASE_SMOKE.md");
    expect(files).not.toContain("PRD.md");
    expect(files).not.toContain("ISSUES.md");
    expect(files).not.toContain("IMPLEMENTATION_PLAN.md");
    expect(files.some((f) => f.startsWith("test/") || f.endsWith(".test.ts"))).toBe(false);
    expect(files.some((f) => f.startsWith("scripts/") || f.startsWith(".github/"))).toBe(false);
    // Only intended categories beyond package.json.
    for (const f of files) {
      if (f === "package.json") continue;
      expect(
        f === "index.ts" ||
          f === "README.md" ||
          f === "LICENSE" ||
          f.startsWith("src/"),
      ).toBe(true);
    }
  });

  it("CI matrices Node 22/24 with Pi 0.80.6/0.80.7 and runs test, typecheck, package smoke", async () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/ci.yml"),
      "utf8",
    );
    // Both verified Pi hosts are matrixed.
    expect(workflow).toMatch(/0\.80\.6/);
    expect(workflow).toMatch(/0\.80\.7/);
    // Gates present in the workflow.
    expect(workflow).toMatch(/npm run typecheck/);
    expect(workflow).toMatch(/\bnpm test\b/);
    expect(workflow).toMatch(/npm run pack:smoke/);
    // Node 22 and 24 must appear as matrix node values (not only comments).
    const nodeMatrix = workflow.match(/node-version\s*:\s*\[([^\]]+)\]/);
    const nodeValues = nodeMatrix
      ? nodeMatrix[1]
      : (workflow.match(/node-version:\s*"?(22|24)"?/g) ?? []).join(" ");
    expect(nodeValues).toMatch(/22/);
    expect(nodeValues).toMatch(/24/);
    const piMatrix = workflow.match(/pi-version\s*:\s*\[([^\]]+)\]/);
    expect(piMatrix?.[1] ?? "").toMatch(/0\.80\.6/);
    expect(piMatrix?.[1] ?? "").toMatch(/0\.80\.7/);
    // Full product: if separate jobs, each job that runs checks must include both dimensions
    // or a shared matrix of node × pi. At minimum, both node majors and both Pi versions
    // appear under strategy.matrix in the workflow.
    expect(workflow).toMatch(/strategy:[\s\S]*matrix:/);
  });

  it(
    "real pack:smoke accepts current allowlist and rejects historical ADR requirement",
    async () => {
      const { execFileSync } = await import("node:child_process");
      let stdout = "";
      let stderr = "";
      try {
        // pack:smoke builds a real tarball, extracts, and loads via Pi local package path.
        stdout = execFileSync("npm", ["run", "pack:smoke"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
      } catch (err: any) {
        stdout = String(err?.stdout ?? "");
        stderr = String(err?.stderr ?? err?.message ?? err);
        throw new Error(`pack:smoke failed:\n${stdout}\n${stderr}`);
      }
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toMatch(/package-smoke OK/);
      expect(combined).not.toMatch(/docs\/adr\/0001/);
      expect(combined).not.toMatch(/missing required runtime path: docs\/adr/);
    },
    120_000,
  );
});
