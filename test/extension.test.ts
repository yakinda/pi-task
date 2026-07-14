import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PreparedChildSession,
  SessionFactory,
  SessionHandle,
} from "../src/child-session.ts";
import { createTaskExtension } from "../index.ts";
import type { ParentModel } from "../src/model.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function agentsDirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-ext-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

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

function mockPi(over: { activeTools?: string[]; thinking?: string } = {}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const model = fakeModel();
  const notifies: Array<{ message: string; type?: string }> = [];
  const logs: string[] = [];
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
    getThinkingLevel: () => over.thinking ?? "medium",
    getActiveTools: () => over.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
    _tools: tools,
    _commands: commands,
    _handlers: handlers,
    _notifies: notifies,
    _logs: logs,
    async emit(event: string, ctx?: any) {
      for (const h of handlers.get(event) ?? []) await h({}, ctx ?? defaultCtx(model, notifies));
    },
  };
  return { pi, model, notifies, logs };
}

function defaultCtx(
  model: ParentModel,
  notifies: Array<{ message: string; type?: string }> = [],
  over: {
    mode?: string;
  } = {},
) {
  return {
    cwd: "/repo",
    mode: over.mode ?? "print",
    model,
    modelRegistry: {
      find: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: (m: ParentModel) => m.provider === model.provider && m.id === model.id,
    },
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string, type?: string) => notifies.push({ message, type }),
    },
  };
}


/**
 * Build a SessionFactory from a simple run callback (tools/cwd/trust/prompt inspection).
 * Prefer this over the removed childSession option.
 */
function sessionFactoryFrom(
  impl: (input: {
    prompt: string;
    tools: string[];
    cwd: string;
    projectTrusted: boolean;
    model: ParentModel;
    agentBody: string;
    thinking?: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; warnings?: string[] }> | { text: string; warnings?: string[] },
): SessionFactory {
  return {
    async create(prepared: PreparedChildSession): Promise<SessionHandle> {
      const messages: Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
        stopReason?: string;
      }> = [];
      return {
        get messages() {
          return messages;
        },
        async prompt(text: string, _options?: { expandPromptTemplates: false }) {
          const outcome = await impl({
            prompt: text,
            tools: [...prepared.tools],
            cwd: prepared.cwd,
            projectTrusted: prepared.projectTrusted,
            model: prepared.model,
            agentBody: prepared.agentBody,
            thinking: prepared.thinking,
          });
          messages.length = 0;
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: outcome.text }],
            stopReason: "stop",
          });
        },
        subscribe() {
          return () => {};
        },
        async abort() {},
        dispose() {},
      };
    },
  };
}

function sessionFactoryOk(text = "ok"): SessionFactory {
  return sessionFactoryFrom(async () => ({ text }));
}



describe("extension registration", () => {
  it("registers exactly one task tool and no extension commands", () => {
    const dir = agentsDirWith({});
    const { pi } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("x"),
    })(pi as any);

    expect([...pi._tools.keys()]).toEqual(["task"]);
    expect(pi._commands.size).toBe(0);
    expect([...pi._commands.keys()]).toEqual([]);

    const tool = pi._tools.get("task");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("task");
    expect(tool.description).toMatch(/No Agent definitions|none/i);
    expect(tool.promptSnippet).toMatch(/Task/);
    expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    for (const g of tool.promptGuidelines) {
      expect(g).toMatch(/Task/);
    }
    const keys = Object.keys(tool.parameters.properties ?? {});
    expect(keys.sort()).toEqual(["description", "prompt", "subagent_type"].sort());
  });

  it("unknown type execute fails with available agents", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
---
body
`,
    });
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("x"),
    })(pi as any);
    const tool = pi._tools.get("task");

    await expect(
      tool.execute(
        "id",
        { description: "d", prompt: "p", subagent_type: "nope" },
        undefined,
        undefined,
        defaultCtx(model),
      ),
    ).rejects.toThrow(/explore/);
  });

  it("happy path through tool execute + fake child session", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read, grep
thinking: low
---
You search.
`,
    });
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {
        seen.push(input);
        return { text: "result text", warnings: [] };
      }),
    })(pi as any);
    const tool = pi._tools.get("task");

    const result = await tool.execute(
      "id",
      { description: "search", prompt: "Find X", subagent_type: "explore" },
      undefined,
      vi.fn(),
      defaultCtx(model),
    );

    expect(result.content[0].text).toContain('state="completed"');
    expect(result.content[0].text).toContain("result text");
    expect(result.details.agent).toBe("explore");
    expect(result.details.model).toBe("xai/m1");
    expect(seen[0].prompt).toBe("Find X");
    expect(seen[0].cwd).toBe("/repo");
    expect(seen[0].tools).toEqual(["read", "grep"]);
  });

  it("parent read-only drops write with warning", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read, write
---
body
`,
    });
    let tools: string[] = [];
    const { pi, model } = mockPi({ activeTools: ["read", "grep"] });
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {

                tools = input.tools;
                return { text: "ok", warnings: [] };

      }),
    })(pi as any);
    const tool = pi._tools.get("task");
    const result = await tool.execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      defaultCtx(model),
    );
    expect(tools).toEqual(["read"]);
    expect(result.details.warnings.some((w: string) => /write/.test(w))).toBe(true);
  });

  it("session_start rediscovers agents and refreshes description", async () => {
    const dir = agentsDirWith({});
    const { pi, model, notifies } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("x"),
    })(pi as any);
    expect(pi._tools.get("task").description).toMatch(/No Agent definitions|none/i);
    expect(pi._commands.size).toBe(0);

    fs.writeFileSync(
      path.join(dir, "explore.md"),
      `---
name: explore
description: Fast search
---
body
`,
    );

    await pi.emit("session_start", defaultCtx(model, notifies));
    expect(pi._tools.get("task").description).toContain("explore: Fast search");
    expect(pi._commands.size).toBe(0);
  });

  it("session_start rediscovers agents and always intersects parent active tools", async () => {
    const dir = agentsDirWith({});

    let childTools: string[] | undefined;
    const { pi, model, notifies } = mockPi({ activeTools: ["read"] });
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {

                childTools = input.tools;
                return { text: "ok", warnings: [] };

      }),
    })(pi as any);

    fs.writeFileSync(
      path.join(dir, "explore.md"),
      `---
name: explore
description: Fast search
tools: read, grep, find
---
body
`,
    );

    await pi.emit("session_start", defaultCtx(model, notifies));
    expect(pi._tools.get("task").description).toContain("explore: Fast search");
    expect(pi._commands.size).toBe(0);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "search", prompt: "find it", subagent_type: "explore" },
      undefined,
      undefined,
      defaultCtx(model, notifies),
    );
    // Parent only has read; grep/find are filtered with warnings (no trusted mode).
    expect(childTools).toEqual(["read"]);
    expect(
      result.details.warnings.some((w: string) => /not active on the parent/i.test(w)),
    ).toBe(true);
  });

  it("missing getActiveTools fails closed before Child Session", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read
---
body
`,
    });
    let runs = 0;
    const { pi, model } = mockPi({ activeTools: ["read"] });
    // Remove the active-tool API entirely.
    delete (pi as { getActiveTools?: unknown }).getActiveTools;
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {

                runs += 1;
                return { text: "should-not-run", warnings: [] };

      }),
    })(pi as any);

    await expect(
      pi._tools.get("task").execute(
        "id",
        { description: "d", prompt: "p", subagent_type: "explore" },
        undefined,
        undefined,
        defaultCtx(model),
      ),
    ).rejects.toThrow(/parent active tools are unavailable/i);
    expect(runs).toBe(0);
  });

  it("throwing getActiveTools fails closed before Child Session", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read
---
body
`,
    });
    let runs = 0;
    const { pi, model } = mockPi({ activeTools: ["read"] });
    (pi as { getActiveTools: () => string[] }).getActiveTools = () => {
      throw new Error("active tools API unavailable");
    };
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {

                runs += 1;
                return { text: "should-not-run", warnings: [] };

      }),
    })(pi as any);

    await expect(
      pi._tools.get("task").execute(
        "id",
        { description: "d", prompt: "p", subagent_type: "explore" },
        undefined,
        undefined,
        defaultCtx(model),
      ),
    ).rejects.toThrow(/parent active tools are unavailable/i);
    expect(runs).toBe(0);
  });

  it("initial load is silent; session_start emits diagnostics once per reload", async () => {
    const dir = agentsDirWith({
      "broken.md": "not an agent",
      "good.md": `---
name: good
description: ok
---
body
`,
    });
    const { pi, model, notifies } = mockPi();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createTaskExtension({
        agentsDir: dir,
      sessionFactory: sessionFactoryOk("x"),
      })(pi as any);

      // Initial load must not emit diagnostics (silent registration).
      expect(notifies).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();

      // First session_start reloads once and emits that reload's diagnostics once.
      await pi.emit("session_start", defaultCtx(model, notifies));
      const diagnosticNotifies = () =>
        notifies.filter(
          (n) =>
            /pi-task:.*(?:frontmatter|diagnostic|Could not|invalid)/i.test(n.message) ||
            n.type === "warning",
        );
      expect(diagnosticNotifies().length).toBe(1);
      const afterStartDiag = diagnosticNotifies().length;

      // Next session_start resets fingerprint then re-emits once for the new session.
      await pi.emit("session_start", defaultCtx(model, notifies));
      expect(diagnosticNotifies().length).toBe(afterStartDiag + 1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits retained Catalog diagnostics when Task runs before session_start", async () => {
    const dir = agentsDirWith({
      "broken.md": "not an agent",
      "good.md": `---
name: good
description: ok
tools: read
---
body
`,
    });
    const { pi, model, notifies } = mockPi({ activeTools: ["read"] });
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("ok"),
    })(pi as any);

    await pi._tools.get("task").execute(
      "id",
      { description: "run", prompt: "p", subagent_type: "good" },
      undefined,
      undefined,
      defaultCtx(model, notifies),
    );

    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({
      type: "warning",
      message: expect.stringContaining("frontmatter"),
    });
  });

  it("rejects empty description before child runs", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
---
body
`,
    });
    let started = false;
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryFrom(async (input) => {

                started = true;
                return { text: "x", warnings: [] };

      }),
    })(pi as any);
    const tool = pi._tools.get("task");
    await expect(
      tool.execute(
        "id",
        { description: "  ", prompt: "p", subagent_type: "explore" },
        undefined,
        undefined,
        defaultCtx(model),
      ),
    ).rejects.toThrow(/description/);
    expect(started).toBe(false);
  });

  it("registers Task-specific renderCall and renderResult", () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
---
body
`,
    });
    const { pi } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("x"),
    })(pi as any);

    expect(pi._commands.size).toBe(0);
    const tool = pi._tools.get("task");
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");

    const theme = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };

    const callComp = tool.renderCall(
      {
        description: "auth audit",
        prompt:
          "Investigate authentication thoroughly and list every call site that touches tokens across the whole codebase with paths",
        subagent_type: "explore",
      },
      theme,
      {},
    );
    const callText = callComp.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(callText).toContain("explore");
    expect(callText).toContain("auth audit");
    // Bounded prompt preview — not the full delegated prompt
    expect(callText).not.toContain(
      "Investigate authentication thoroughly and list every call site that touches tokens across the whole codebase with paths",
    );
    expect(callText).toMatch(/Investigate authentication/);

    const resultComp = tool.renderResult(
      {
        content: [{ type: "text", text: '<task state="completed"/>' }],
        details: {
          agent: "explore",
          description: "auth audit",
          subagentType: "explore",
          phase: "completed",
          warnings: ["skipped write"],
          elapsedMs: 1000,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const resultText = resultComp.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(resultText).toMatch(/completed/i);
    expect(resultText).toContain("explore");
    expect(resultText).toMatch(/1\.0s|1s|1000ms/);
    expect(resultText).toMatch(/1 warning|warning/i);

    // Expanded run report uses retained details (resume-safe)
    const fullPrompt =
      "Investigate authentication thoroughly and list every call site that touches tokens across the whole codebase with paths";
    const expandedComp = tool.renderResult(
      {
        content: [{ type: "text", text: '<task state="completed"/>' }],
        details: {
          agent: "explore",
          description: "auth audit",
          subagentType: "explore",
          model: "xai/m1",
          thinking: "low",
          tools: ["read", "grep"],
          phase: "completed",
          prompt: fullPrompt,
          resultText: "## Findings\n\n- tokens in `auth.ts`",
          warnings: ["skipped write"],
          elapsedMs: 1000,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    const expandedText = expandedComp
      .render(120)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(expandedText).toContain(fullPrompt);
    expect(expandedText).toMatch(/model:.*xai\/m1/);
    expect(expandedText).not.toMatch(/\(parent\)|modelSource/i);
    expect(expandedText).toMatch(/thinking:.*low/);
    expect(expandedText).toMatch(/tools:.*read/);
    expect(expandedText).toContain("skipped write");
    expect(expandedText).toContain("auth.ts");
    expect(expandedText).toMatch(/Findings|tokens/);
    // Collapsed must not dump full prompt
    expect(resultText).not.toContain(fullPrompt);
  });

  it("execute path remains functional without invoking renderers (print/JSON/RPC)", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read
---
body
`,
    });
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("result text"),
    })(pi as any);
    expect(pi._commands.size).toBe(0);
    const tool = pi._tools.get("task");

    // Simulate print mode: execute only — renderers must not be required.
    const result = await tool.execute(
      "id",
      { description: "search", prompt: "Find X", subagent_type: "explore" },
      undefined,
      undefined,
      defaultCtx(model, [], { mode: "print" }),
    );

    expect(result.content[0].text).toContain("result text");
    expect(result.details.agent).toBe("explore");
    expect(result.details.phase).toBe("completed");
    // Model-visible channel is XML; human details stay out of the content contract
    expect(result.content[0].text).toContain('state="completed"');
    // Human-only fields are additive on details (for TUI expanded view / resume)
    expect(result.details.prompt).toBe("Find X");
    expect(result.details.resultText).toBe("result text");
    expect(result.content[0].text).not.toContain("resultText");
  });
});

describe("Issue 5 — no artifact runtime or session_shutdown cleanup", () => {
  it("does not register session_shutdown and never creates result artifacts", async () => {
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: d
tools: [read]
---
body
`,
    });

    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: dir,
      sessionFactory: sessionFactoryOk("x".repeat(9_000)),
    })(pi as any);

    expect(pi._commands.size).toBe(0);
    expect(pi._handlers.get("session_shutdown") ?? []).toEqual([]);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "large", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      defaultCtx(model),
    );
    expect(result.details.phase).toBe("completed");
    expect(result.details).not.toHaveProperty("resultArtifact");
    expect(result.details).not.toHaveProperty("resultRetention");
    expect(result.details).not.toHaveProperty("resultTruncation");
    expect(result.details.resultText).toContain("...[truncated");
    expect(result.content[0].text).toContain("...[truncated");
    // Equality contract: details.resultText matches XML logical content
    const cdata = String(result.content[0].text).match(
      /<task_result>([\s\S]*)<\/task_result>/,
    )?.[1] ?? "";
    const logical = cdata.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    expect(result.details.resultText).toBe(logical);
    expect(result.details.warnings.some((w: string) => /truncated/i.test(w))).toBe(true);
    expect(result.details.warnings.some((w: string) => /artifact/i.test(w))).toBe(false);
  });
});

describe("parent trust snapshot (fail-closed)", () => {
  const TRUST_UNAVAILABLE_WARNING =
    "Project trust unavailable; Child Session defaults to untrusted.";

  function agentDir() {
    return agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read
---
body
`,
    });
  }

  it("explicit trusted Primary state produces a trusted Child Session", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "trusted-ok", warnings: [] };

      }),
    })(pi as any);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      { ...defaultCtx(model), isProjectTrusted: () => true },
    );

    expect(seen[0]?.projectTrusted).toBe(true);
    expect(result.details.warnings).not.toContain(TRUST_UNAVAILABLE_WARNING);
    expect(result.content[0].text).toContain('state="completed"');
    expect(result.content[0].text).not.toContain(TRUST_UNAVAILABLE_WARNING);
  });

  it("explicit untrusted Primary state produces an untrusted Child Session", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "untrusted-ok", warnings: [] };

      }),
    })(pi as any);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      { ...defaultCtx(model), isProjectTrusted: () => false },
    );

    expect(seen[0]?.projectTrusted).toBe(false);
    expect(result.details.warnings).not.toContain(TRUST_UNAVAILABLE_WARNING);
    expect(result.content[0].text).toContain('state="completed"');
    expect(result.content[0].text).not.toContain(TRUST_UNAVAILABLE_WARNING);
  });

  it("missing trust lookup resolves to untrusted and never trusted", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "missing-trust-ok", warnings: [] };

      }),
    })(pi as any);

    const ctx = defaultCtx(model);
    delete (ctx as { isProjectTrusted?: unknown }).isProjectTrusted;

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      ctx,
    );

    expect(seen[0]?.projectTrusted).toBe(false);
    expect(seen[0]?.projectTrusted).not.toBe(true);
    expect(result.content[0].text).toContain('state="completed"');
  });

  it("throwing trust lookup resolves to untrusted and never trusted", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "throwing-trust-ok", warnings: [] };

      }),
    })(pi as any);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      {
        ...defaultCtx(model),
        isProjectTrusted: () => {
          throw new Error("trust API unavailable");
        },
      },
    );

    expect(seen[0]?.projectTrusted).toBe(false);
    expect(seen[0]?.projectTrusted).not.toBe(true);
    expect(result.content[0].text).toContain('state="completed"');
  });

  it("missing trust lookup adds one deterministic Warning in details and model XML", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "missing-warn-ok", warnings: [] };

      }),
    })(pi as any);

    const ctx = defaultCtx(model);
    delete (ctx as { isProjectTrusted?: unknown }).isProjectTrusted;

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      ctx,
    );

    expect(seen[0]?.projectTrusted).toBe(false);
    const trustWarnings = result.details.warnings.filter(
      (w: string) => w === TRUST_UNAVAILABLE_WARNING,
    );
    expect(trustWarnings).toHaveLength(1);
    expect(result.content[0].text).toContain('state="completed"');
    expect(result.content[0].text).toContain(`<warning>${TRUST_UNAVAILABLE_WARNING}</warning>`);
    // Exactly one occurrence of the warning text in model XML
    expect(result.content[0].text.split(TRUST_UNAVAILABLE_WARNING)).toHaveLength(2);
  });

  it("throwing trust lookup adds one deterministic Warning in details and model XML", async () => {
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "throw-warn-ok", warnings: [] };

      }),
    })(pi as any);

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      {
        ...defaultCtx(model),
        isProjectTrusted: () => {
          throw new Error("trust API unavailable");
        },
      },
    );

    expect(seen[0]?.projectTrusted).toBe(false);
    const trustWarnings = result.details.warnings.filter(
      (w: string) => w === TRUST_UNAVAILABLE_WARNING,
    );
    expect(trustWarnings).toHaveLength(1);
    expect(result.content[0].text).toContain('state="completed"');
    expect(result.content[0].text).toContain(`<warning>${TRUST_UNAVAILABLE_WARNING}</warning>`);
    expect(result.content[0].text.split(TRUST_UNAVAILABLE_WARNING)).toHaveLength(2);
  });

  it("trust fallback preserves model selection, tool policy, and throw semantics", async () => {
    // Agent requests write which parent does not have → tool policy still filters.
    const dir = agentsDirWith({
      "explore.md": `---
name: explore
description: Fast search
tools: read, write
---
body
`,
    });
    const seen: { tools: string[]; cwd: string; projectTrusted: boolean; model: ParentModel; prompt: string }[] = [];
    const { pi, model } = mockPi({ activeTools: ["read", "grep"] });
    createTaskExtension({
      agentsDir: dir,
      // Isolate settings so safe-mode parent intersection is guaranteed.
      sessionFactory: sessionFactoryFrom(async (input) => {

                seen.push(input);
                return { text: "policy-ok", warnings: [] };

      }),
    })(pi as any);

    const ctx = defaultCtx(model);
    delete (ctx as { isProjectTrusted?: unknown }).isProjectTrusted;

    const result = await pi._tools.get("task").execute(
      "id",
      { description: "d", prompt: "p", subagent_type: "explore" },
      undefined,
      undefined,
      ctx,
    );

    // Fail-closed trust
    expect(seen[0]?.projectTrusted).toBe(false);
    // Model selection unchanged (parent model)
    expect(seen[0]?.model).toBe(model);
    expect(result.details.model).toBe("xai/m1");
    // Tool policy still applied (write dropped)
    expect(seen[0]?.tools).toEqual(["read"]);
    expect(result.details.warnings.some((w: string) => /write/.test(w))).toBe(true);
    // Trust warning still present once
    expect(
      result.details.warnings.filter((w: string) => w === TRUST_UNAVAILABLE_WARNING),
    ).toHaveLength(1);
    expect(result.content[0].text).toContain('state="completed"');

    // Unknown agent still throws (throw semantics unchanged)
    await expect(
      pi._tools.get("task").execute(
        "id",
        { description: "d", prompt: "p", subagent_type: "nope" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/explore/);
  });

  it("trust fallback preserves abort semantics", async () => {
    const { pi, model } = mockPi();
    createTaskExtension({
      agentsDir: agentDir(),
      sessionFactory: sessionFactoryFrom(async (input) => {

                if (input.signal?.aborted) {
                  const err = new Error("aborted");
                  err.name = "AbortError";
                  throw err;
                }
                return { text: "should-not-run", warnings: [] };

      }),
    })(pi as any);

    const ctx = defaultCtx(model);
    delete (ctx as { isProjectTrusted?: unknown }).isProjectTrusted;
    const ac = new AbortController();
    ac.abort();

    await expect(
      pi._tools.get("task").execute(
        "id",
        { description: "d", prompt: "p", subagent_type: "explore" },
        ac.signal,
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
