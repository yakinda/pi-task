import { describe, expect, it } from "vitest";
import {
  buildSpecialistSystemPrompt,
  createChildSessionRunner,
  FINAL_ANSWER_WRAPPER,
  interpretOutcome,
  type ChildActivityEvent,
  type ChildMessage,
  type ChildSessionEvent,
  type PreparedChildSession,
  type SessionFactory,
  type SessionHandle,
} from "../src/child-session.ts";
import type { ParentModel } from "../src/model.ts";

function fakeModel(): ParentModel {
  return {
    id: "m1",
    name: "m1",
    api: "openai-completions",
    provider: "xai",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as ParentModel;
}

function baseInput(over: Partial<Parameters<ReturnType<typeof createChildSessionRunner>["run"]>[0]> = {}) {
  return {
    prompt: "do work",
    agentBody: "You are explore.",
    tools: ["read", "grep"],
    model: fakeModel(),
    modelRegistry: {
      find: () => fakeModel(),
      hasConfiguredAuth: () => true,
    },
    cwd: "/repo",
    projectTrusted: true,
    ...over,
  };
}

class FakeHandle implements SessionHandle {
  messages: ChildMessage[] = [];
  promptCalls: Array<{ text: string; options: { expandPromptTemplates: false } }> = [];
  abortCalls = 0;
  disposeCalls = 0;
  listeners: Array<(e: ChildSessionEvent) => void> = [];
  promptImpl: (text: string) => Promise<void> = async () => {};
  disposeImpl: () => void = () => {};
  abortImpl: () => Promise<void> = async () => {};

  async prompt(text: string, options: { expandPromptTemplates: false }) {
    this.promptCalls.push({ text, options });
    await this.promptImpl(text);
  }

  subscribe(listener: (event: ChildSessionEvent) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async abort() {
    this.abortCalls += 1;
    await this.abortImpl();
  }

  dispose() {
    this.disposeCalls += 1;
    this.disposeImpl();
  }

  emit(event: ChildSessionEvent) {
    for (const l of this.listeners) l(event);
  }
}

function factoryWith(handle: FakeHandle, onCreate?: (input: PreparedChildSession) => void): SessionFactory {
  return {
    async create(input) {
      onCreate?.(input);
      return handle;
    },
  };
}

describe("buildSpecialistSystemPrompt", () => {
  it("is agent body + fixed final-answer contract only", () => {
    const prompt = buildSpecialistSystemPrompt("  You are explore.  ");
    expect(prompt).toBe(`You are explore.\n\n${FINAL_ANSWER_WRAPPER.trim()}`);
    expect(prompt).not.toMatch(/Current date:|Current working directory:|project_context|AGENTS/i);
  });

  it("uses only the contract when body is empty/whitespace", () => {
    expect(buildSpecialistSystemPrompt("   ")).toBe(FINAL_ANSWER_WRAPPER.trim());
  });
});

describe("interpretOutcome", () => {
  it("previous tool-calling assistant has text, final assistant error → fail", () => {
    expect(() =>
      interpretOutcome([
        {
          role: "assistant",
          content: [{ type: "text", text: "stale progress" }],
          stopReason: "toolUse",
        },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider down",
        },
      ]),
    ).toThrow(/provider down/);
  });

  it("final assistant multi text parts concatenate in order", () => {
    const out = interpretOutcome([
      {
        role: "assistant",
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        stopReason: "stop",
      },
    ]);
    expect(out.text).toBe("AB");
    expect(out).not.toHaveProperty("usage");
  });

  it("stopReason=length → success + warning", () => {
    const out = interpretOutcome([
      { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "length" },
    ]);
    expect(out.text).toBe("partial");
    expect(out.warnings.some((w) => /length/.test(w))).toBe(true);
  });

  it("stopReason=aborted → abort error", () => {
    expect(() =>
      interpretOutcome([
        { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "aborted" },
      ]),
    ).toThrow(/aborted/i);
  });

  it("empty final text → error", () => {
    expect(() =>
      interpretOutcome([
        { role: "assistant", content: [{ type: "text", text: "  " }], stopReason: "stop" },
      ]),
    ).toThrow(/empty final assistant text/);
  });

  it("tool-only final → failure", () => {
    expect(() =>
      interpretOutcome([
        { role: "assistant", content: [], stopReason: "toolUse" },
      ]),
    ).toThrow(/tool-only/);
  });

  it("missing assistant → failure", () => {
    expect(() => interpretOutcome([{ role: "user", content: "hi" }])).toThrow(
      /no assistant message/,
    );
  });
});

describe("ChildSessionRunner lifecycle", () => {
  it("happy path: prompt expandPromptTemplates false, returns text, cleans up", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    const out = await runner.run(baseInput());
    expect(out.text).toBe("done");
    expect(out.warnings).toEqual([]);
    expect(out).not.toHaveProperty("usage");
    expect(handle.promptCalls[0].options.expandPromptTemplates).toBe(false);
    expect(handle.promptCalls[0].text).toBe("do work");
    expect(handle.disposeCalls).toBe(1);
    expect(handle.listeners).toHaveLength(0);
  });

  it("abort signal calls session.abort once and throws", async () => {
    const handle = new FakeHandle();
    const ac = new AbortController();
    handle.promptImpl = async () => {
      ac.abort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await expect(runner.run(baseInput({ signal: ac.signal }))).rejects.toThrow(/abort/i);
    expect(handle.abortCalls).toBeGreaterThanOrEqual(1);
    expect(handle.disposeCalls).toBe(1);
  });

  it("consumes a rejected abort notification without masking the Task abort", async () => {
    const handle = new FakeHandle();
    const ac = new AbortController();
    handle.abortImpl = async () => {
      throw new Error("provider abort failed");
    };
    handle.promptImpl = async () => {
      ac.abort();
      await Promise.resolve();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };

    const runner = createChildSessionRunner(factoryWith(handle));
    await expect(runner.run(baseInput({ signal: ac.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(handle.abortCalls).toBeGreaterThanOrEqual(1);
    expect(handle.disposeCalls).toBe(1);
  });

  it("provider/session factory throw still disposes if session created", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      throw new Error("llm down");
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await expect(runner.run(baseInput())).rejects.toThrow(/llm down/);
    expect(handle.disposeCalls).toBe(1);
  });

  it("factory throw before session → no dispose", async () => {
    const runner = createChildSessionRunner({
      async create() {
        throw new Error("create failed");
      },
    });
    await expect(runner.run(baseInput())).rejects.toThrow(/create failed/);
  });

  it("cleanup throw does not mask original failure", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      throw new Error("primary");
    };
    handle.disposeImpl = () => {
      throw new Error("dispose boom");
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await expect(runner.run(baseInput())).rejects.toThrow(/primary/);
  });

  it("cleanup throw does not mask success", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    handle.disposeImpl = () => {
      throw new Error("dispose boom");
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    const out = await runner.run(baseInput());
    expect(out.text).toBe("ok");
  });

  it("forwards tool activity with identity/name/status only (no args)", async () => {
    const handle = new FakeHandle();
    const events: ChildActivityEvent[] = [];
    handle.promptImpl = async () => {
      handle.emit({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
      });
      handle.emit({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
      });
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await runner.run(baseInput({ onActivity: (e) => events.push(e) }));
    expect(events).toEqual([
      { type: "tool", toolCallId: "c1", toolName: "read", status: "running" },
      { type: "tool", toolCallId: "c1", toolName: "read", status: "completed" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/args|result|path|secret/i);
  });

  it("tool end with isError maps to status error (failed)", async () => {
    const handle = new FakeHandle();
    const events: ChildActivityEvent[] = [];
    handle.promptImpl = async () => {
      handle.emit({
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "bash",
      });
      handle.emit({
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "bash",
        isError: true,
      });
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await runner.run(baseInput({ onActivity: (e) => events.push(e) }));
    expect(events).toEqual([
      { type: "tool", toolCallId: "c2", toolName: "bash", status: "running" },
      { type: "tool", toolCallId: "c2", toolName: "bash", status: "error" },
    ]);
  });

  it("correlates tool start/end by call identity across interleaved tools", async () => {
    const handle = new FakeHandle();
    const events: ChildActivityEvent[] = [];
    handle.promptImpl = async () => {
      handle.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
      handle.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "grep" });
      handle.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "grep", isError: false });
      handle.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true });
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await runner.run(baseInput({ onActivity: (e) => events.push(e) }));
    expect(events.map((e) => `${e.toolCallId}:${e.status}`)).toEqual([
      "a:running",
      "b:running",
      "b:completed",
      "a:error",
    ]);
  });

  it("never exposes tool result bodies or message deltas at the seam", async () => {
    const handle = new FakeHandle();
    const events: ChildActivityEvent[] = [];
    handle.promptImpl = async () => {
      handle.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" });
      handle.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false });
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await runner.run(baseInput({ onActivity: (e) => events.push(e) }));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/result|partialResult|output|body|heartbeat|message_activity/i);
  });

  it("unsubscribe runs so listeners are empty after success", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await runner.run(baseInput({ onActivity: () => {} }));
    expect(handle.listeners).toHaveLength(0);
    expect(handle.disposeCalls).toBe(1);
  });

  it("abort path unsubscribes, aborts, and disposes", async () => {
    const handle = new FakeHandle();
    const ac = new AbortController();
    handle.promptImpl = async () => {
      ac.abort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };
    const runner = createChildSessionRunner(factoryWith(handle));
    await expect(
      runner.run(baseInput({ signal: ac.signal, onActivity: () => {} })),
    ).rejects.toThrow(/abort/i);
    expect(handle.listeners).toHaveLength(0);
    expect(handle.abortCalls).toBeGreaterThanOrEqual(1);
    expect(handle.disposeCalls).toBe(1);
  });

  it("passes prepared tools/model/trust into factory without skills", async () => {
    const handle = new FakeHandle();
    handle.promptImpl = async () => {
      handle.messages = [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ];
    };
    let prepared: PreparedChildSession | undefined;
    const model = fakeModel();
    const runner = createChildSessionRunner(
      factoryWith(handle, (input) => {
        prepared = input;
      }),
    );
    await runner.run(
      baseInput({
        model,
        tools: ["read"],
        projectTrusted: false,
        agentBody: "Role body",
      }),
    );
    expect(prepared?.model).toBe(model);
    expect(prepared?.tools).toEqual(["read"]);
    expect(prepared?.projectTrusted).toBe(false);
    expect(prepared?.agentBody).toBe("Role body");
    expect(prepared && "skills" in prepared).toBe(false);
    expect(prepared && "messages" in prepared).toBe(false);
    expect(prepared && "parentMessages" in prepared).toBe(false);
  });

  it("pre-aborted signal never creates a session", async () => {
    let created = 0;
    const ac = new AbortController();
    ac.abort();
    const runner = createChildSessionRunner({
      async create() {
        created += 1;
        throw new Error("should not create");
      },
    });
    await expect(runner.run(baseInput({ signal: ac.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(created).toBe(0);
  });
});
