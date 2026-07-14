import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAgentCatalog,
  type AgentCatalogSnapshot,
  type Diagnostic,
} from "../src/catalog.ts";
import type { ChildSessionRunner } from "../src/child-session.ts";
import type { ModelRegistryLike, ParentModel } from "../src/model.ts";
import { Semaphore } from "../src/semaphore.ts";
import {
  createTaskExecutor,
  validateTaskRequest,
  type TaskPhase,
  type TaskProgress,
} from "../src/task.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

function catalogWithExplore(tools?: string[]): AgentCatalogSnapshot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-cat-"));
  tempDirs.push(dir);
  const toolsLine = tools ? `tools: ${tools.join(", ")}\n` : "";
  fs.writeFileSync(
    path.join(dir, "explore.md"),
    `---
name: explore
description: Fast search
${toolsLine}thinking: low
---
You are explore.
`,
  );
  return loadAgentCatalog(dir);
}

function manualClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

function phasesOf(progress: TaskProgress[]): TaskPhase[] {
  return progress.map((p) => p.details.phase!).filter(Boolean);
}

function okChild(text = "ok", warnings: string[] = []): ChildSessionRunner {
  return {
    async run() {
      return { text, warnings };
    },
  };
}

describe("validateTaskRequest", () => {
  it("rejects empty/whitespace params", () => {
    expect(() => validateTaskRequest({ description: "  ", prompt: "p", subagentType: "e" })).toThrow(
      /description/,
    );
    expect(() => validateTaskRequest({ description: "d", prompt: " ", subagentType: "e" })).toThrow(
      /prompt/,
    );
    expect(() => validateTaskRequest({ description: "d", prompt: "p", subagentType: " " })).toThrow(
      /subagent_type/,
    );
  });

  it("rejects description > 120", () => {
    expect(() =>
      validateTaskRequest({ description: "x".repeat(121), prompt: "p", subagentType: "e" }),
    ).toThrow(/120/);
  });
});

describe("TaskExecutor", () => {
  it("surfaces the current Catalog diagnostics through diagnosticSink", async () => {
    const baseCatalog = catalogWithExplore(["read"]);
    const diagnostic = {
      code: "agent_test_warning",
      message: "test catalog warning",
      path: "/agents/explore.md",
    };
    const snapshot: AgentCatalogSnapshot = {
      ...baseCatalog,
      diagnostics: [diagnostic],
    };
    const received: Array<readonly Diagnostic[]> = [];
    const executor = createTaskExecutor({
      catalog: () => snapshot,
      diagnosticSink: (diagnostics) => received.push(diagnostics),
      childSession: okChild("ok"),
      semaphore: new Semaphore(4),
    });

    const result = await executor.execute(
      { description: "diagnostics", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
    );

    expect(result.details.phase).toBe("completed");
    expect(received).toEqual([[diagnostic]]);
  });

  it("does not let a throwing diagnosticSink alter Task execution", async () => {
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      diagnosticSink: () => {
        throw new Error("diagnostic consumer failed");
      },
      childSession: okChild("ok"),
      semaphore: new Semaphore(4),
    });

    const result = await executor.execute(
      { description: "diagnostics", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
    );

    expect(result.details.phase).toBe("completed");
    expect(result.details.resultText).toBe("ok");
  });

  it("happy path packages XML and details without usage/activity history", async () => {
    const model = fakeModel();
    const seen: any[] = [];
    const childSession: ChildSessionRunner = {
      async run(input) {
        seen.push(input);
        return { text: "found Foo", warnings: [] };
      },
    };
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read", "grep"]),
      childSession,
      semaphore: new Semaphore(4),
    });

    const result = await executor.execute(
      { description: "find Foo", prompt: "Search for Foo", subagentType: "Explore" },
      {
        cwd: "/repo",
        parentModel: model,
        modelRegistry: registry(model),
        parentThinking: "medium",
        activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        projectTrusted: true,
      },
    );

    expect(result.text).toContain('state="completed"');
    expect(result.text).toContain("found Foo");
    expect(result.details.agent).toBe("explore");
    expect(result.details.model).toBe("xai/m1");
    expect(result.details).not.toHaveProperty("modelSource");
    expect(result.details.thinking).toBe("low");
    expect(result.details.tools).toEqual(["read", "grep"]);
    expect(result.details.phase).toBe("completed");
    expect(typeof result.details.elapsedMs).toBe("number");
    expect(result.details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.details).not.toHaveProperty("timing");
    expect(result.details).not.toHaveProperty("usage");
    expect(result.details).not.toHaveProperty("activity");
    expect(result.details).not.toHaveProperty("queue");
    expect(result.details).not.toHaveProperty("droppedActivityCount");
    expect(result.details).not.toHaveProperty("currentTool");
    expect(result.details.prompt).toBe("Search for Foo");
    expect(result.details.resultText).toBe("found Foo");
    expect(result.text).not.toContain("<prompt");
    expect(result.text).not.toContain("resultText");
    expect(seen[0].prompt).toBe("Search for Foo");
    expect(seen[0].tools).toEqual(["read", "grep"]);
    expect(seen[0].skills).toBeUndefined();
    expect(seen[0].thinking).toBe("low");
    expect(seen[0]).not.toHaveProperty("heartbeatIntervalMs");
    expect("messages" in seen[0]).toBe(false);
  });

  it("emits running → completed for immediate execution (no preparing/finalizing)", async () => {
    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: okChild("ok"),
    });

    const result = await executor.execute(
      { description: "imm", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
      (p) => progress.push(p),
    );

    expect(phasesOf(progress)).toEqual(["running", "completed"]);
    expect(progress.some((p) => (p.details.phase as string) === "preparing")).toBe(false);
    expect(progress.some((p) => (p.details.phase as string) === "finalizing")).toBe(false);
    expect(progress.some((p) => p.details.phase === "queued")).toBe(false);
    expect(result.details.phase).toBe("completed");
    expect(result.details).not.toHaveProperty("queue");

    const completed = progress.find((p) => p.details.phase === "completed");
    expect(completed).toBeDefined();
    expect(completed!.details.resultText).toBe("ok");
    expect(typeof completed!.details.elapsedMs).toBe("number");
    expect(completed!.details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(completed!.details).not.toHaveProperty("timing");
    expect(completed!.details).not.toHaveProperty("usage");
    expect(completed!.details).not.toHaveProperty("currentTool");
    expect(completed!.text).toMatch(/Completed explore: imm|completed/i);
  });

  it("emits queued only when slot unavailable (no queue counts retained)", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const progress: TaskProgress[] = [];
    const childGate = gate();
    let childStarted = false;

    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: sem,
      childSession: {
        async run() {
          childStarted = true;
          await childGate.promise;
          return { text: "ok", warnings: [] };
        },
      },
    });

    const pending = executor.execute(
      { description: "wait", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
      (p) => progress.push(p),
    );

    for (let i = 0; i < 20 && !progress.some((p) => p.details.phase === "queued"); i++) {
      await Promise.resolve();
    }

    const queued = progress.find((p) => p.details.phase === "queued");
    expect(queued).toBeDefined();
    expect(queued!.details).not.toHaveProperty("queue");
    expect(queued!.text).toMatch(/Queued explore: wait/);
    expect(queued!.text).not.toMatch(/active=|waiting=/);
    expect(childStarted).toBe(false);

    hold();
    for (let i = 0; i < 20 && !childStarted; i++) await Promise.resolve();
    expect(childStarted).toBe(true);

    childGate.release();
    const result = await pending;
    expect(result.details.phase).toBe("completed");
    expect(phasesOf(progress)).toEqual(["queued", "running", "completed"]);
  });

  it("records elapsed with injectable clock", async () => {
    const clock = manualClock(10_000);
    const childGate = gate();

    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      clock: clock.now,
      childSession: {
        async run() {
          clock.advance(40);
          await childGate.promise;
          return { text: "ok", warnings: [] };
        },
      },
    });

    const pending = executor.execute(
      { description: "time", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
    );

    for (let i = 0; i < 20; i++) await Promise.resolve();
    childGate.release();
    const result = await pending;

    expect(result.details.elapsedMs).toBe(40);
    expect(result.details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.details).not.toHaveProperty("timing");
    expect(result.details).not.toHaveProperty("startedAt");
  });

  it("queued abort never starts a child and releases no slot", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    let childStarted = false;
    const ac = new AbortController();

    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: sem,
      childSession: {
        async run() {
          childStarted = true;
          return { text: "no", warnings: [] };
        },
      },
    });

    const progress: TaskProgress[] = [];
    const waiting = executor.execute(
      { description: "queued", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
        signal: ac.signal,
      },
      (p) => progress.push(p),
    );

    for (let i = 0; i < 20 && !progress.some((p) => p.details.phase === "queued"); i++) {
      await Promise.resolve();
    }
    expect(progress.some((p) => p.details.phase === "queued")).toBe(true);

    ac.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(childStarted).toBe(false);
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(0);
    expect(progress.some((p) => p.details.phase === "aborted")).toBe(true);

    hold();
    expect(sem.activeCount).toBe(0);
  });

  it("failed child emits failed phase and still releases semaphore", async () => {
    const sem = new Semaphore(1);
    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: sem,
      childSession: {
        async run() {
          throw new Error("child blew up");
        },
      },
    });

    await expect(
      executor.execute(
        { description: "boom", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read"],
          projectTrusted: true,
        },
        (p) => progress.push(p),
      ),
    ).rejects.toThrow(/child blew up/);

    expect(progress.some((p) => p.details.phase === "failed")).toBe(true);
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("ordinary errors containing abort-like words stay failed (not aborted)", async () => {
    const cases = [
      "ECONNABORTED: connection aborted by peer",
      "failed to abort transport mid-flight",
      "upstream abort protocol mismatch",
    ];

    for (const message of cases) {
      const progress: TaskProgress[] = [];
      const executor = createTaskExecutor({
        catalog: () => catalogWithExplore(["read"]),
        semaphore: new Semaphore(4),
        childSession: {
          async run() {
            throw new Error(message);
          },
        },
      });

      await expect(
        executor.execute(
          { description: "ops", prompt: "p", subagentType: "explore" },
          {
            cwd: "/",
            parentModel: fakeModel(),
            modelRegistry: registry(),
            parentThinking: undefined,
            activeTools: ["read"],
            projectTrusted: true,
          },
          (p) => progress.push(p),
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe(message);
        expect((err as Error).name).not.toBe("AbortError");
        return true;
      });

      expect(progress.some((p) => p.details.phase === "failed")).toBe(true);
      expect(progress.some((p) => p.details.phase === "aborted")).toBe(false);
    }
  });

  it("named AbortError from child is classified as aborted", async () => {
    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          const err = new Error("child session aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    });

    await expect(
      executor.execute(
        { description: "stop-me", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read"],
          projectTrusted: true,
        },
        (p) => progress.push(p),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).message).toMatch(/Task aborted: stop-me/);
      return true;
    });

    expect(progress.some((p) => p.details.phase === "aborted")).toBe(true);
    expect(progress.some((p) => p.details.phase === "failed")).toBe(false);
  });

  it("progress callback exception on completed does not turn success into failure", async () => {
    let completedEmits = 0;
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: "ok", warnings: ["soft note"] };
        },
      },
    });

    const result = await executor.execute(
      { description: "prog-throw", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
      (p) => {
        if (p.details.phase === "completed") {
          completedEmits += 1;
          throw new Error("onProgress blew up on completed");
        }
      },
    );

    expect(completedEmits).toBe(1);
    expect(result.details.phase).toBe("completed");
    expect(result.text).toContain('state="completed"');
    expect(result.details.resultText).toBe("ok");
    expect(result.details.warnings).toContain("soft note");
  });

  it("progress observer failures never strand a queued Task or semaphore slot", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    let childRuns = 0;
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: sem,
      childSession: {
        async run() {
          childRuns += 1;
          return { text: "ok", warnings: [] };
        },
      },
    });

    const pending = executor.execute(
      { description: "observer", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
      () => {
        throw new Error("observer failed");
      },
    );

    for (let i = 0; i < 20 && sem.waitingCount === 0; i++) await Promise.resolve();
    expect(sem.waitingCount).toBe(1);
    first();

    const result = await pending;
    expect(result.details.phase).toBe("completed");
    expect(childRuns).toBe(1);
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("validation/prep failure does not acquire semaphore", async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    let childStarted = false;
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(),
      childSession: {
        async run() {
          childStarted = true;
          return { text: "x", warnings: [] };
        },
      },
      semaphore: sem,
    });

    await expect(
      executor.execute(
        { description: "  ", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read"],
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/description/);

    expect(childStarted).toBe(false);
    expect(sem.waitingCount).toBe(0);
    hold();
  });

  it("empty tools after filter fails before child", async () => {
    let childStarted = false;
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["write"]),
      childSession: {
        async run() {
          childStarted = true;
          return { text: "x", warnings: [] };
        },
      },
      semaphore: new Semaphore(4),
    });

    await expect(
      executor.execute(
        { description: "d", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read", "grep"],
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/No usable tools/);
    expect(childStarted).toBe(false);
  });

  it("fifth task waits; abort queued never starts child", async () => {
    const gateSem = new Semaphore(4);
    const blockers: Array<() => void> = [];
    const block = () =>
      new Promise<void>((resolve) => {
        blockers.push(resolve);
      });

    const catalog = catalogWithExplore(["read"]);
    const model = fakeModel();
    const runtime = {
      cwd: "/",
      parentModel: model,
      modelRegistry: registry(model),
      parentThinking: undefined as undefined,
      activeTools: ["read"],
      projectTrusted: true,
    };

    const makeExecutor = (child: ChildSessionRunner) =>
      createTaskExecutor({
        catalog: () => catalog,
        childSession: child,
        semaphore: gateSem,
      });

    const longChild: ChildSessionRunner = {
      async run() {
        await block();
        return { text: "ok", warnings: [] };
      },
    };

    const executor = makeExecutor(longChild);
    const running = Array.from({ length: 4 }, (_, i) =>
      executor.execute(
        { description: `hold-${i}`, prompt: "p", subagentType: "explore" },
        runtime,
      ),
    );

    for (let i = 0; i < 50 && gateSem.activeCount < 4; i++) await Promise.resolve();
    expect(gateSem.activeCount).toBe(4);

    const ac = new AbortController();
    let started = false;
    const waiting = makeExecutor({
      async run() {
        started = true;
        return { text: "no", warnings: [] };
      },
    }).execute(
      { description: "queued", prompt: "p", subagentType: "explore" },
      { ...runtime, signal: ac.signal },
    );

    for (let i = 0; i < 20 && gateSem.waitingCount < 1; i++) await Promise.resolve();
    expect(gateSem.waitingCount).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(started).toBe(false);

    for (const release of blockers) release();
    await Promise.all(running);
  });

  it("max observed child concurrency is 4", async () => {
    const gateSem = new Semaphore(4);
    let concurrent = 0;
    let maxSeen = 0;
    const catalog = catalogWithExplore(["read"]);
    const model = fakeModel();
    const releaseGates: Array<() => void> = [];
    const executor = createTaskExecutor({
      catalog: () => catalog,
      semaphore: gateSem,
      childSession: {
        async run() {
          concurrent += 1;
          maxSeen = Math.max(maxSeen, concurrent);
          await new Promise<void>((resolve) => releaseGates.push(resolve));
          concurrent -= 1;
          return { text: "ok", warnings: [] };
        },
      },
    });

    const runtime = {
      cwd: "/",
      parentModel: model,
      modelRegistry: registry(model),
      parentThinking: undefined as undefined,
      activeTools: ["read"],
      projectTrusted: true,
    };

    const all = Array.from({ length: 8 }, (_, i) =>
      executor.execute(
        { description: `t${i}`, prompt: "p", subagentType: "explore" },
        runtime,
      ),
    );

    for (let i = 0; i < 50 && releaseGates.length < 4; i++) await Promise.resolve();
    expect(maxSeen).toBe(4);
    expect(releaseGates.length).toBe(4);

    const firstWave = releaseGates.splice(0, 4);
    for (const r of firstWave) r();
    for (let i = 0; i < 50 && releaseGates.length < 4; i++) await Promise.resolve();
    expect(maxSeen).toBe(4);
    for (const r of releaseGates.splice(0)) r();
    await Promise.all(all);
    expect(maxSeen).toBe(4);
  });

  it("partial progress shows only current tool name/status (no args or history)", async () => {
    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read", "bash"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run(input) {
          input.onActivity?.({
            type: "tool",
            toolCallId: "t-read",
            toolName: "read",
            status: "running",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "t-bash",
            toolName: "bash",
            status: "running",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "t-bash",
            toolName: "bash",
            status: "error",
          });
          input.onActivity?.({
            type: "tool",
            toolCallId: "t-read",
            toolName: "read",
            status: "completed",
          });
          return { text: "ok", warnings: [] };
        },
      },
    });

    const result = await executor.execute(
      { description: "tools", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read", "bash"],
        projectTrusted: true,
      },
      (p) => progress.push(p),
    );

    // Terminal details omit current tool
    expect(result.details).not.toHaveProperty("currentTool");
    expect(result.details).not.toHaveProperty("activity");

    const running = progress.filter((p) => p.details.phase === "running" && p.details.currentTool);
    expect(running.length).toBeGreaterThanOrEqual(1);
    // Interleaving is correlated by call identity: when bash ends, read remains
    // the visible running tool until its own completion.
    expect(running.map((p) => p.details.currentTool)).toEqual([
      { toolName: "read", status: "running" },
      { toolName: "bash", status: "running" },
      { toolName: "read", status: "running" },
      { toolName: "read", status: "completed" },
    ]);

    // Partial details carry at most one current tool (name/status only; no history/args/id)
    for (const p of running) {
      expect(p.details.currentTool).toBeDefined();
      expect(p.details.currentTool).toHaveProperty("toolName");
      expect(p.details.currentTool).toHaveProperty("status");
      expect(p.details.currentTool).not.toHaveProperty("toolCallId");
      expect(p.details.currentTool).not.toHaveProperty("args");
      expect(p.details.currentTool).not.toHaveProperty("argsSummary");
      expect(JSON.stringify(p.details.currentTool)).not.toMatch(/path|command|result/i);
    }

    // Progress text shows only name/status marks — no args
    const previewLines = progress
      .filter((p) => p.details.phase === "running")
      .map((p) => p.text)
      .join("\n");
    expect(previewLines).toMatch(/→ read|✓ read|→ bash|✗ bash/);
    expect(previewLines).not.toMatch(/src\/a\.ts|echo hi/);
  });

  it("warnings from capabilities appear in XML and details", async () => {
    const catalog = catalogWithExplore(["read", "write", "task"]);
    const model = fakeModel();
    const executor = createTaskExecutor({
      catalog: () => catalog,
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: "ok", warnings: ["child note"] };
        },
      },
    });

    const result = await executor.execute(
      { description: "w", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: model,
        modelRegistry: registry(model),
        parentThinking: undefined,
        activeTools: ["read", "grep"],
        projectTrusted: true,
      },
    );

    expect(result.text).toContain("<warnings>");
    expect(result.details.warnings.some((w) => /write/.test(w))).toBe(true);
    expect(result.details.warnings.some((w) => /task/.test(w))).toBe(true);
    expect(result.details.warnings).toContain("child note");
  });

  it("unknown agent lists catalog", async () => {
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(),
      childSession: okChild("x"),
      semaphore: new Semaphore(4),
    });
    await expect(
      executor.execute(
        { description: "d", prompt: "p", subagentType: "nope" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read"],
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/explore/);
  });

  it("exposes exact effective configuration in final details", async () => {
    const model = fakeModel("anthropic", "claude");
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read", "write", "task"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run(input) {
          expect(input.thinking).toBe("low");
          expect(input.tools).toEqual(["read"]);
          return { text: "cfg", warnings: ["child soft warning"] };
        },
      },
    });

    const result = await executor.execute(
      { description: "cfg", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: model,
        modelRegistry: registry(model),
        parentThinking: "max",
        activeTools: ["read", "grep"],
        projectTrusted: true,
      },
    );

    expect(result.details.agent).toBe("explore");
    expect(result.details.model).toBe("anthropic/claude");
    expect(result.details).not.toHaveProperty("modelSource");
    expect(result.details.thinking).toBe("low");
    expect(result.details.tools).toEqual(["read"]);
    expect(result.details.warnings.some((w) => /write/.test(w))).toBe(true);
    expect(result.details.warnings.some((w) => /task/.test(w))).toBe(true);
    expect(result.details.warnings).toContain("child soft warning");
    expect(result.details).not.toHaveProperty("usage");
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
  });

  it("prep failure never invokes Child Session runner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-empty-"));
    tempDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "explore.md"),
      `---
name: explore
description: Fast search
tools: []
thinking: low
---
You are explore.
`,
    );
    const catalog = loadAgentCatalog(dir);
    expect(catalog.find("explore")?.tools).toEqual([]);

    let runs = 0;
    const executor = createTaskExecutor({
      catalog: () => catalog,
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          runs += 1;
          return { text: "should-not-run", warnings: [] };
        },
      },
    });

    await expect(
      executor.execute(
        { description: "empty tools", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: ["read"],
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/explicitly empty/i);
    expect(runs).toBe(0);
  });

  it("missing parent active tools API fails closed before Child Session", async () => {
    let runs = 0;
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          runs += 1;
          return { text: "should-not-run", warnings: [] };
        },
      },
    });

    await expect(
      executor.execute(
        { description: "api fail", prompt: "p", subagentType: "explore" },
        {
          cwd: "/",
          parentModel: fakeModel(),
          modelRegistry: registry(),
          parentThinking: undefined,
          activeTools: [],
          activeToolsApiFailed: true,
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/parent active tools are unavailable/i);
    expect(runs).toBe(0);
  });

  it("parent-inactive tools are filtered with warnings (no trusted mode)", async () => {
    const seen: any[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read", "write", "task", "intercom"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run(input) {
          seen.push(input);
          return { text: "ok", warnings: [] };
        },
      },
    });

    const result = await executor.execute(
      { description: "filter", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
    );

    expect(seen[0].tools).toEqual(["read"]);
    expect(result.details.tools).toEqual(["read"]);
    expect(result.details.warnings.some((w) => /write/i.test(w))).toBe(true);
    expect(result.details.warnings.some((w) => /task/i.test(w))).toBe(true);
    expect(result.details.warnings.some((w) => /intercom/i.test(w))).toBe(true);
  });

  it("persists human-only prompt and resultText; progress text never carries full prompt", async () => {
    const fullPrompt =
      "Investigate authentication thoroughly and list every call site that touches tokens across the whole codebase with paths and line numbers.";
    const childAnswer = "## Report\n\n- tokens in auth.ts";
    const progress: TaskProgress[] = [];
    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: childAnswer, warnings: [] };
        },
      },
    });

    const result = await executor.execute(
      { description: "auth", prompt: fullPrompt, subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
      (p) => progress.push(p),
    );

    expect(result.details.prompt).toBe(fullPrompt);
    expect(result.details.resultText).toBe(childAnswer);

    const running = progress.find((p) => p.details.phase === "running");
    expect(running?.details.prompt).toBe(fullPrompt);
    expect(running?.details.resultText).toBeUndefined();

    for (const p of progress) {
      expect(p.text).not.toContain(fullPrompt);
      expect(p.text).not.toContain(childAnswer);
    }

    expect(result.text).toContain(childAnswer);
    expect(result.text).not.toContain("resultText");
    expect(result.text).not.toMatch(/<prompt[\s>]/);
  });

  it("normalizes truncated results into equal model XML and human resultText", async () => {
    const big = "A".repeat(5000) + "MIDDLE_MARKER" + "B".repeat(5000);
    const { RESULT_SOFT_CAP, codePointLength } = await import("../src/result.ts");

    const executor = createTaskExecutor({
      catalog: () => catalogWithExplore(["read"]),
      semaphore: new Semaphore(4),
      childSession: {
        async run() {
          return { text: big, warnings: [] };
        },
      },
    });

    const result = await executor.execute(
      { description: "big-result", prompt: "p", subagentType: "explore" },
      {
        cwd: "/",
        parentModel: fakeModel(),
        modelRegistry: registry(),
        parentThinking: undefined,
        activeTools: ["read"],
        projectTrusted: true,
      },
    );

    expect(result.details.phase).toBe("completed");
    expect(result.details).not.toHaveProperty("resultTruncation");
    expect(result.details).not.toHaveProperty("resultArtifact");
    expect(result.details).not.toHaveProperty("resultRetention");
    expect(result.text).toContain('state="completed"');
    expect(result.text).toContain("...[truncated");
    expect(result.text).not.toContain("MIDDLE_MARKER");
    expect(result.details.resultText).not.toContain("MIDDLE_MARKER");
    expect(codePointLength(result.details.resultText!)).toBe(RESULT_SOFT_CAP);
    // Exact equality: details.resultText matches XML <task_result> logical content
    const cdata = result.text.match(/<task_result>([\s\S]*)<\/task_result>/)?.[1] ?? "";
    const logical = cdata.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    expect(result.details.resultText).toBe(logical);
    expect(result.details.warnings.some((w) => /truncated/i.test(w))).toBe(true);
    expect(result.details.warnings.some((w) => /artifact/i.test(w))).toBe(false);
  });
});
