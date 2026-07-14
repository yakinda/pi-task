import { describe, expect, it } from "vitest";
import { CODING_TOOLS, resolveCapabilities, TASK_TOOL_NAME } from "../src/capabilities.ts";

const fullParent = [...CODING_TOOLS];
const readOnlyParent = ["read", "grep", "find", "ls"];

describe("resolveCapabilities", () => {
  const cases: Array<{
    name: string;
    agentTools: string[] | undefined;
    parent: string[];
    expected?: string[];
    throws?: RegExp;
    warningsInclude?: string[];
  }> = [
    {
      name: "parent full + agent omitted → all coding tools",
      agentTools: undefined,
      parent: fullParent,
      expected: [...CODING_TOOLS],
    },
    {
      name: "parent read-only + agent omitted → intersect",
      agentTools: undefined,
      parent: readOnlyParent,
      expected: ["read", "grep", "find", "ls"],
    },
    {
      name: "parent read-only + explicit read,grep,write → write dropped with warning",
      agentTools: ["read", "grep", "write"],
      parent: readOnlyParent,
      expected: ["read", "grep"],
      warningsInclude: ['Tool "write" is not active on the parent agent and was skipped'],
    },
    {
      name: "explicit task is always removed",
      agentTools: ["read", "task"],
      parent: fullParent,
      expected: ["read"],
      warningsInclude: ["nested task is disabled"],
    },
    {
      name: "unknown tool dropped",
      agentTools: ["read", "intercom"],
      parent: fullParent,
      expected: ["read"],
      warningsInclude: ['Unknown or custom tool "intercom"'],
    },
    {
      name: "duplicate tool names deduped",
      agentTools: ["read", "read", "grep", "grep"],
      parent: fullParent,
      expected: ["read", "grep"],
    },
    {
      name: "explicit empty list fails",
      agentTools: [],
      parent: fullParent,
      throws: /explicitly empty/,
    },
    {
      name: "empty-after-filter fails",
      agentTools: ["write", "task"],
      parent: readOnlyParent,
      throws: /No usable tools/,
    },
    {
      name: "task alone fails",
      agentTools: ["task"],
      parent: fullParent,
      throws: /No usable tools/,
    },
    {
      name: "parent-inactive built-in is filtered with warning",
      agentTools: ["read", "grep", "write"],
      parent: readOnlyParent,
      expected: ["read", "grep"],
      warningsInclude: ["not active on the parent"],
    },
    {
      name: "omitted tools always intersect parent (no trusted mode)",
      agentTools: undefined,
      parent: readOnlyParent,
      expected: ["read", "grep", "find", "ls"],
    },
    {
      name: "empty parent active tools fails closed",
      agentTools: ["read", "grep"],
      parent: [],
      throws: /No usable tools/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const input = {
        agentTools: c.agentTools,
        parentActiveTools: c.parent,
      };
      if (c.throws) {
        expect(() => resolveCapabilities(input)).toThrow(c.throws);
        return;
      }
      const result = resolveCapabilities(input);
      expect(result.tools).toEqual(c.expected);
      expect(result.tools).not.toContain(TASK_TOOL_NAME);
      if (c.warningsInclude) {
        for (const w of c.warningsInclude) {
          expect(result.warnings.some((x) => x.includes(w))).toBe(true);
        }
      }
    });
  }

  it("empty-after-filter does not call further work (pure throw)", () => {
    expect(() =>
      resolveCapabilities({
        agentTools: ["write"],
        parentActiveTools: ["read"],
      }),
    ).toThrow(/No usable tools/);
  });

  it("warning order is deterministic", () => {
    const a = resolveCapabilities({
      agentTools: ["task", "intercom", "write", "read"],
      parentActiveTools: ["read", "grep"],
    });
    const b = resolveCapabilities({
      agentTools: ["task", "intercom", "write", "read"],
      parentActiveTools: ["read", "grep"],
    });
    expect(a.warnings).toEqual(b.warnings);
    expect(a.tools).toEqual(["read"]);
  });
});
