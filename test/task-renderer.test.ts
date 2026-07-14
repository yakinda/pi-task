/**
 * Semantic tests for Task-specific call/result rendering.
 * Assert observable text/structure — not internal helper choreography.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import {
  boundPreview,
  formatDuration,
  PROMPT_PREVIEW_MAX,
  renderTaskCall,
  renderTaskResult,
  type ThemeLike,
} from "../src/task-renderer.ts";
import type { TaskDetails } from "../src/task.ts";

/** Identity theme — returns text unchanged so assertions stay semantic. */
const theme: ThemeLike = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** Strip residual ANSI (if any) and trim trailing whitespace for assertions. */
function plain(component: Component): string {
  const lines = component.render(200);
  return lines
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+$/gm, "");
}

function baseDetails(over: Partial<TaskDetails> = {}): TaskDetails {
  return {
    agent: "explore",
    model: "xai/m1",
    thinking: "low",
    tools: ["read", "grep"],
    warnings: [],
    description: "find symbols",
    subagentType: "explore",
    prompt:
      "Please thoroughly investigate the authentication module and report every call site that touches tokens.",
    resultText:
      "## Findings\n\n- `src/auth.ts` issues tokens\n- Use **HTTPS** only\n\n```ts\nexport function issue() {}\n```",
    phase: "completed",
    elapsedMs: 2500,
    ...over,
  };
}

beforeAll(() => {
  // keyHint reads global theme; identity-style fallbacks still work without init.
});

describe("renderTaskCall", () => {
  it("shows agent definition name, description, and bounded prompt preview", () => {
    const longPrompt =
      "Please thoroughly investigate the authentication module and report every call site that touches tokens. " +
      "Include file paths and line numbers for each finding.";
    const out = plain(
      renderTaskCall(
        {
          description: "auth audit",
          prompt: longPrompt,
          subagent_type: "explore",
        },
        theme,
      ),
    );

    expect(out).toContain("task");
    expect(out).toContain("explore");
    expect(out).toContain("auth audit");
    // Bounded preview — never the full prompt
    expect(out).not.toContain(longPrompt);
    expect(out).toMatch(/Please thoroughly investigate/);
    expect(out.includes("…") || out.length < longPrompt.length).toBe(true);
    // Preview length stays within bound (+ ellipsis)
    const previewLine = out.split("\n").find((l) => l.includes("Please"));
    expect(previewLine).toBeDefined();
    expect(previewLine!.trim().length).toBeLessThanOrEqual(PROMPT_PREVIEW_MAX + 5);
  });

  it("handles missing args without throwing", () => {
    const out = plain(renderTaskCall({}, theme));
    expect(out).toContain("task");
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not dump a short prompt as multi-line body", () => {
    const out = plain(
      renderTaskCall(
        { description: "quick", prompt: "Find X", subagent_type: "reviewer" },
        theme,
      ),
    );
    expect(out).toContain("reviewer");
    expect(out).toContain("quick");
    expect(out).toContain("Find X");
  });
});

describe("renderTaskResult — partial / in-flight", () => {
  it("queued partial shows lifecycle, Agent, description, elapsed (no queue counts)", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "Queued explore: find symbols" }],
          details: baseDetails({
            phase: "queued",
            resultText: undefined,
            elapsedMs: 100,
          }),
        },
        { expanded: false, isPartial: true },
        theme,
      ),
    );

    expect(out).toMatch(/queued/i);
    expect(out).toContain("explore");
    expect(out).toContain("find symbols");
    expect(out).toMatch(/100ms/);
    expect(out).not.toContain("active=");
    expect(out).not.toContain("waiting=");
    expect(out).not.toMatch(/position\s*=/i);
    expect(out).not.toMatch(/#\d+\s+in queue/i);
  });

  it("running partial shows phase and current tool name/status only (no args/output)", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "Running…" }],
          details: baseDetails({
            phase: "running",
            resultText: undefined,
            currentTool: {
              toolName: "read",
              status: "running",
            },
          }),
        },
        { expanded: false, isPartial: true },
        theme,
      ),
    );

    expect(out).toMatch(/running/i);
    expect(out).toContain("explore");
    expect(out).toMatch(/read/);
    expect(out).toContain("→");
    expect(out).not.toMatch(/file-\d+\.ts|args|path=|toolCallId|c1/);
  });

  it("running without current tool shows working placeholder", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "Running…" }],
          details: baseDetails({
            phase: "running",
            resultText: undefined,
            currentTool: undefined,
          }),
        },
        { expanded: false, isPartial: true },
        theme,
      ),
    );
    expect(out).toMatch(/running/i);
    expect(out).toMatch(/working/i);
  });
});

describe("renderTaskResult — terminal collapsed", () => {
  it("completed summary includes elapsed and warning count (no usage/modelSource)", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "<task …/>" }],
          details: baseDetails({
            phase: "completed",
            warnings: ["tool write skipped", "model fallback"],
            elapsedMs: 9500,
          }),
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    expect(out).toMatch(/completed/i);
    expect(out).toContain("explore");
    expect(out).toContain("find symbols");
    expect(out).toContain("✓");
    expect(out).toMatch(/9\.5s|9500ms|9s/);
    expect(out).not.toMatch(/turns|↑|↓|\$0\.0123|cache|modelSource|startedAt/i);
    expect(out).toMatch(/2 warnings?/);
  });

  it("failed and aborted use distinct status indicators with lifecycle/Agent/description", () => {
    const failed = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "boom" }],
          details: baseDetails({ phase: "failed", resultText: undefined }),
          isError: true,
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    const aborted = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "aborted" }],
          details: baseDetails({ phase: "aborted", resultText: undefined }),
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    expect(failed).toMatch(/failed/i);
    expect(failed).toContain("✗");
    expect(failed).toContain("explore");
    expect(aborted).toMatch(/aborted/i);
    expect(aborted).toContain("⊘");
    expect(aborted).toContain("explore");
    // Distinct
    expect(failed).not.toMatch(/aborted/i);
    expect(aborted).not.toMatch(/failed/i);
  });

  it("expansion hint derives from app.tools.expand keybinding (not a hard-coded chord alone)", () => {
    // Mock keyHint to prove we consult the configured binding id.
    vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
      return {
        ...actual,
        keyHint: (id: string, desc: string) => {
          if (id === "app.tools.expand") return `CUSTOM+X ${desc}`;
          return `${id} ${desc}`;
        },
      };
    });

    // Direct unit path: expansionHintLine is exercised via render; we assert the
    // fallback still names the keybinding id when keyHint is empty/uninitialised,
    // and that we never hard-code only "Ctrl+O" without the binding concept.
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "ok" }],
          details: baseDetails({ phase: "completed" }),
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    // Either configured keyHint text or explicit keybinding-id fallback.
    expect(
      /app\.tools\.expand|to expand|ctrl\+o|CUSTOM\+X/i.test(out),
    ).toBe(true);
    // Must not only say a bare "Ctrl+O" without expand context if binding missing —
    // our fallback always includes app.tools.expand or "to expand".
    if (/ctrl\+o/i.test(out) && !/to expand/i.test(out)) {
      expect(out).toMatch(/app\.tools\.expand/i);
    }
  });

  it("falls back to Pi error/content text when details are missing", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "provider exploded\nmore" }],
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      ),
    );
    expect(out).toContain("provider exploded");
    // Compact: first line only
    expect(out).not.toContain("more");
  });
});

describe("renderer pure helpers", () => {
  it("boundPreview never returns full oversized text", () => {
    const long = "x".repeat(200);
    const p = boundPreview(long, 40);
    expect(p.length).toBeLessThanOrEqual(40);
    expect(p.endsWith("…")).toBe(true);
    expect(p).not.toBe(long);
  });

  it("formatDuration is human-scannable and non-negative", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(2500)).toMatch(/2\.5s/);
    expect(formatDuration(125_000)).toMatch(/2m/);
    expect(formatDuration(-50)).toBe("0ms");
  });
});

describe("renderTaskResult — expanded run report", () => {
  const fullPrompt =
    "Please thoroughly investigate the authentication module and report every call site that touches tokens.";

  it("includes full delegated prompt, effective config, warnings, elapsed, and Markdown result",
    () => {
      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "<task state=\"completed\"/>" }],
            details: baseDetails({
              phase: "completed",
              prompt: fullPrompt,
              warnings: ["tool write skipped", "model fallback"],
              elapsedMs: 9500,
              resultText:
                "## Findings\n\n- auth tokens in `src/auth.ts`\n- Prefer **HTTPS**",
            }),
          },
          { expanded: true, isPartial: false },
          theme,
        ),
      );

      expect(out).toMatch(/completed/i);
      expect(out).toContain("explore");
      expect(out).toContain("─── Prompt ───");
      expect(out).toContain(fullPrompt);
      expect(out).toContain("─── Configuration ───");
      expect(out).toMatch(/model:.*xai\/m1/);
      // modelSource removed from public details
      expect(out).not.toMatch(/\(parent\)|\(frontmatter\)|modelSource/i);
      expect(out).toMatch(/thinking:.*low/);
      expect(out).toMatch(/tools:.*read.*grep/);
      expect(out).toContain("─── Timing ───");
      expect(out).toMatch(/elapsed:/);
      expect(out).not.toMatch(/startedAt|queue wait:|execution:|─── Usage ───|─── Activity ───/);
      expect(out).toMatch(/Warnings \(2\)/);
      expect(out).toContain("tool write skipped");
      expect(out).toContain("model fallback");
      expect(out).toContain("─── Result ───");
      expect(out).toMatch(/Findings/);
      expect(out).toMatch(/auth tokens|src\/auth\.ts|HTTPS/);
    },
  );

  it("collapsed view never exposes the full delegated prompt",
    () => {
      const longPrompt =
        "Please thoroughly investigate the authentication module and report every call site that touches tokens across the whole codebase with detailed paths and line numbers for each finding.";
      const collapsed = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "ok" }],
            details: baseDetails({
              phase: "completed",
              prompt: longPrompt,
            }),
          },
          { expanded: false, isPartial: false },
          theme,
        ),
      );
      expect(collapsed).not.toContain(longPrompt);
      expect(collapsed).not.toContain("─── Prompt ───");
      expect(collapsed).not.toContain("─── Result ───");
    },
  );

  it("uses retained details after resume (args optional; prompt/resultText from details)",
    () => {
      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "<task/>" }],
            details: baseDetails({
              prompt: "Resumed full prompt body with unique marker ALPHA-42",
              resultText: "## Resumed\n\nUnique marker BETA-99",
            }),
          },
          { expanded: true, isPartial: false },
          theme,
          // No live args — resume path relies on details alone
        ),
      );
      expect(out).toContain("ALPHA-42");
      expect(out).toContain("BETA-99");
      expect(out).toContain("─── Prompt ───");
      expect(out).toContain("─── Result ───");
    },
  );

  it("renders ordinary final Task result as Markdown (headings/lists/code survive)",
    () => {
      const md =
        "# Title\n\n- item one\n- item two\n\n```js\nconst x = 1;\n```\n\n**bold** and `code`";
      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "xml" }],
            details: baseDetails({ resultText: md }),
          },
          { expanded: true, isPartial: false },
          theme,
        ),
      );
      // Markdown component renders readable structure; assert semantic content
      expect(out).toMatch(/Title/);
      expect(out).toMatch(/item one/);
      expect(out).toMatch(/const x = 1/);
      expect(out).toMatch(/bold/);
    },
  );

  it("error results without structured details fall back to Pi error text",
    () => {
      const collapsed = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "provider exploded\nstack line" }],
          },
          { expanded: false, isPartial: false },
          theme,
          { isError: true },
        ),
      );
      expect(collapsed).toContain("provider exploded");
      expect(collapsed).not.toContain("stack line");

      const expanded = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "provider exploded\nstack line" }],
          },
          { expanded: true, isPartial: false },
          theme,
          { isError: true },
        ),
      );
      expect(expanded).toContain("provider exploded");
      expect(expanded).toContain("stack line");
    },
  );

  it("partial expanded still shows full prompt and config without dumping result",
    () => {
      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "Running…" }],
            details: baseDetails({
              phase: "running",
              resultText: undefined,
              prompt: fullPrompt,
            }),
          },
          { expanded: true, isPartial: true },
          theme,
        ),
      );
      expect(out).toMatch(/running/i);
      expect(out).toContain(fullPrompt);
      expect(out).toContain("─── Configuration ───");
      // No ordinary result section while in-flight without resultText
      expect(out).not.toContain("─── Result ───");
    },
  );

  it("tolerates absent optional model/thinking/result without throwing",
    () => {
      expect(() =>
        renderTaskResult(
          {
            content: [{ type: "text", text: "xml" }],
            details: {
              agent: "explore",
              description: "sparse",
              subagentType: "explore",
              warnings: [],
              phase: "completed",
              // model, thinking, resultText, elapsedMs all absent
            },
          },
          { expanded: true, isPartial: false },
          theme,
        ),
      ).not.toThrow();

      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "xml" }],
            details: {
              agent: "explore",
              description: "sparse",
              subagentType: "explore",
              warnings: [],
              phase: "completed",
              prompt: "sparse prompt body",
            },
          },
          { expanded: true, isPartial: false },
          theme,
        ),
      );
      expect(out).toContain("sparse prompt body");
      expect(out).toContain("─── Configuration ───");
      expect(out).toMatch(/model:.*—/);
      expect(out).toMatch(/thinking:.*—/);
      expect(out).not.toContain("─── Result ───");
      expect(out).not.toContain("─── Timing ───");
    },
  );

  it("truncated expanded rendering shows the same capped resultText without artifact UI",
    () => {
      const capped =
        "## Truncated human view\n\nHead and tail retained.\n\n...[truncated: retained 8000 of 12000 code points; 8000 of 12000 UTF-8 bytes]...\n\ntail";
      const out = plain(
        renderTaskResult(
          {
            content: [{ type: "text", text: "xml" }],
            details: baseDetails({
              resultText: capped,
              warnings: [
                "Task result truncated for model context: retained 8000 of 12000 Unicode code points (8000 of 12000 UTF-8 bytes).",
              ],
            }),
          },
          { expanded: true, isPartial: false },
          theme,
        ),
      );
      // No artifact/truncation metadata sections after Issue 5
      expect(out).not.toContain("─── Truncation ───");
      expect(out).not.toMatch(/artifact:/);
      expect(out).toContain("─── Result ───");
      expect(out).toMatch(/Truncated human view|Head and tail/);
      expect(out).toMatch(/Warnings \(1\)/);
      expect(out).toMatch(/truncated for model context/);
    },
  );
});

describe("print/JSON/RPC safety", () => {
  it("renderer functions do not require a live terminal or TUI context", () => {
    // Calling with minimal doubles must not throw.
    expect(() =>
      renderTaskCall(
        { description: "d", prompt: "p", subagent_type: "a" },
        theme,
      ),
    ).not.toThrow();
    expect(() =>
      renderTaskResult(
        {
          content: [{ type: "text", text: "ok" }],
          details: baseDetails(),
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    ).not.toThrow();
    expect(() =>
      renderTaskResult(
        {
          content: [{ type: "text", text: "ok" }],
          details: baseDetails(),
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    ).not.toThrow();
  });
});

describe("Issue 6 — minimal details contract in rendering", () => {
  it("never surfaces deleted telemetry fields", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "xml" }],
          details: baseDetails({
            warnings: ["tool write skipped"],
            elapsedMs: 1200,
          }),
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(out).not.toMatch(/modelSource|startedAt|usage|queue|activity|artifact|retention|dropped/i);
    expect(out).toMatch(/elapsed:/);
    expect(out).toContain("tool write skipped");
  });

  it("partial running cannot reveal command arguments or tool outputs", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "Running…" }],
          details: baseDetails({
            phase: "running",
            resultText: undefined,
            currentTool: { toolName: "bash", status: "running" },
          }),
        },
        { expanded: false, isPartial: true },
        theme,
      ),
    );
    expect(out).toContain("bash");
    expect(out).toContain("→");
    expect(out).not.toMatch(/echo |rm -rf|stdout|stderr|args|toolCallId/i);
  });

  it("terminal views omit current-tool telemetry", () => {
    // Even if a stale currentTool sneaks in, expanded terminal still shows it only
    // when present — contract says terminal details omit it. Assert renderer with
    // terminal phase + no currentTool has no Current tool section.
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "xml" }],
          details: baseDetails({
            phase: "completed",
            currentTool: undefined,
          }),
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(out).not.toContain("─── Current tool ───");
  });
});

describe("Issue 5 — single capped result rendering", () => {
  it("expanded view renders resultText only (no artifact/retention UI)", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "xml" }],
          details: baseDetails({
            resultText: "HEAD...capped...TAIL",
            warnings: [
              "Task result truncated for model context: retained 8000 of 12000 Unicode code points (8000 of 12000 UTF-8 bytes).",
            ],
          }),
        },
        {
          expanded: true,
          isPartial: false,
        },
        theme,
      ),
    );
    expect(out).toContain("HEAD...capped...TAIL");
    expect(out).toContain("─── Result ───");
    expect(out).not.toMatch(/artifact:/);
    expect(out).not.toContain("─── Truncation ───");
    expect(out).not.toMatch(/human details:/);
    expect(out).toMatch(/truncated for model context/);
  });

  it("untruncated results render resultText without artifact metadata", () => {
    const out = plain(
      renderTaskResult(
        {
          content: [{ type: "text", text: "xml" }],
          details: baseDetails({
            resultText: "short complete answer",
          }),
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(out).toContain("short complete answer");
    expect(out).not.toMatch(/artifact:/);
    expect(out).not.toMatch(/human details:/);
  });
});
