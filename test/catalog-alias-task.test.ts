/**
 * Canonical-name lookup through Catalog + TaskExecutor.
 * Aliases are no longer Catalog identities (Issue 2).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentCatalog } from "../src/catalog.ts";
import type { ChildSessionRunner } from "../src/child-session.ts";
import type { ModelRegistryLike, ParentModel } from "../src/model.ts";
import { Semaphore } from "../src/semaphore.ts";
import { createTaskExecutor, type TaskProgress } from "../src/task.ts";

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

function catalogWithExplore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-alias-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "explore.md"),
    `---
name: Explore
description: Fast search
aliases:
  - search
  - FindStuff
tools: read, grep
thinking: low
---
You are explore.
`,
  );
  return loadAgentCatalog(dir);
}

describe("TaskExecutor canonical lookup after alias removal", () => {
  it("resolves case-insensitively by canonical name and ignores aliases", async () => {
    const model = fakeModel();
    const seen: unknown[] = [];
    const progress: TaskProgress[] = [];
    const childSession: ChildSessionRunner = {
      async run(input) {
        seen.push(input);
        return {
          text: "found via canonical",
          warnings: [],
        };
      },
    };

    const catalog = catalogWithExplore();
    // Migration diagnostic for aliases presence; definition still available.
    expect(catalog.diagnostics.some((d) => d.code === "agent_removed_field_aliases")).toBe(true);
    expect(catalog.find("search")).toBeUndefined();
    expect(catalog.find("Explore")?.name).toBe("Explore");

    const executor = createTaskExecutor({
      catalog: () => catalog,

      childSession,
      semaphore: new Semaphore(4),
    });

    await expect(
      executor.execute(
        {
          description: "find Foo",
          prompt: "Search for Foo",
          subagentType: "SEARCH",
        },
        {
          cwd: "/repo",
          parentModel: model,
          modelRegistry: registry(model),
          parentThinking: "medium",
          activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
          projectTrusted: true,
        },
      ),
    ).rejects.toThrow(/Unknown subagent_type "SEARCH"/);

    const result = await executor.execute(
      {
        description: "find Foo",
        prompt: "Search for Foo",
        subagentType: "explore",
      },
      {
        cwd: "/repo",
        parentModel: model,
        modelRegistry: registry(model),
        parentThinking: "medium",
        activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        projectTrusted: true,
      },
      (p) => progress.push(p),
    );

    expect(result.details.agent).toBe("Explore");
    expect(result.details.subagentType).toBe("explore");
    expect(result.text).toContain("found via canonical");
    expect(result.details.tools).toEqual(["read", "grep"]);

    for (const p of progress) {
      expect(p.details.agent).toBe("Explore");
      expect(p.text).toMatch(/Explore/i);
    }

    expect(seen).toHaveLength(1);
    expect((seen[0] as { tools: string[] }).tools).toEqual(["read", "grep"]);
    expect((seen[0] as { skills?: string[] }).skills).toBeUndefined();
  });
});
