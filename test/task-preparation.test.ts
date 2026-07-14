import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../src/catalog.ts";
import type { ModelRegistryLike, ParentModel } from "../src/model.ts";
import {
  ACTIVE_TOOLS_UNAVAILABLE_ERROR,
  prepareAgentTask,
  prepareAgentTaskOrThrow,
  type TaskPreparationRuntime,
} from "../src/task-preparation.ts";

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

function registry(
  models: Array<{ provider: string; id: string; auth?: boolean }> = [
    { provider: "xai", id: "m1" },
  ],
): ModelRegistryLike {
  const map = new Map(
    models.map((m) => [
      `${m.provider}/${m.id}`,
      { model: fakeModel(m.provider, m.id), auth: m.auth !== false },
    ]),
  );
  return {
    find(provider, modelId) {
      return map.get(`${provider}/${modelId}`)?.model;
    },
    hasConfiguredAuth(model) {
      return map.get(`${model.provider}/${model.id}`)?.auth ?? false;
    },
  };
}

function agent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: over.name ?? "explore",
    description: over.description ?? "Fast search",
    tools: over.tools,
    model: over.model,
    thinking: over.thinking,
    body: over.body ?? "You are explore.",
    filePath: over.filePath ?? "/tmp/explore.md",
  };
}

function runtime(over: Partial<TaskPreparationRuntime> = {}): TaskPreparationRuntime {
  const model = over.parentModel ?? fakeModel();
  return {
    parentModel: "parentModel" in over ? over.parentModel : model,
    modelRegistry:
      "modelRegistry" in over
        ? over.modelRegistry
        : registry([{ provider: model.provider, id: model.id }]),
    parentThinking: "parentThinking" in over ? over.parentThinking : "medium",
    activeTools: over.activeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
    activeToolsApiFailed: over.activeToolsApiFailed,
    projectTrusted: over.projectTrusted ?? true,
  };
}

describe("prepareAgentTask", () => {
  it("resolves parent model cascade and agent thinking", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read", "grep"], thinking: "low" }),
      runtime(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.modelId).toBe("xai/m1");
    expect(result.prepared.source).toBe("parent");
    expect(result.prepared.thinking).toBe("low");
    expect(result.prepared.tools).toEqual(["read", "grep"]);
    expect(result.prepared.projectTrusted).toBe(true);
    expect(result.prepared.warnings).toEqual([]);
  });

  it("reports capability reductions as Warnings", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read", "bash", "task"] }),
      runtime({ activeTools: ["read"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.tools).toEqual(["read"]);
    expect(result.prepared.warnings.some((w) => /task/i.test(w))).toBe(true);
    expect(result.prepared.warnings.some((w) => /bash/i.test(w))).toBe(true);
  });

  it("fails when no usable tools remain", () => {
    const result = prepareAgentTask(
      agent({ tools: ["bash"] }),
      runtime({ activeTools: ["read"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No usable tools/i);
    expect(result.tools).toBeUndefined();
  });

  it("fails on explicit empty tools allowlist", () => {
    const result = prepareAgentTask(agent({ tools: [] }), runtime());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/explicitly empty/i);
  });

  it("fails closed when parent active-tool API failed", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read"] }),
      runtime({ activeTools: [], activeToolsApiFailed: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(ACTIVE_TOOLS_UNAVAILABLE_ERROR);
    expect(result.tools).toBeUndefined();
  });

  it("fails when model registry is missing", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read"] }),
      runtime({ modelRegistry: undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/model registry is unavailable/i);
    expect(result.tools).toEqual(["read"]);
  });

  it("fails when parent model has no auth and agent model is unusable", () => {
    const parent = fakeModel("xai", "parent");
    const result = prepareAgentTask(
      agent({ tools: ["read"], model: "xai/missing" }),
      runtime({
        parentModel: parent,
        modelRegistry: registry([
          { provider: "xai", id: "missing", auth: false },
          { provider: "xai", id: "parent", auth: false },
        ]),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Could not resolve a usable model/i);
    expect(result.warnings.some((w) => /no configured auth/i.test(w))).toBe(true);
    expect(result.tools).toEqual(["read"]);
  });

  it("records skipped agent model as Warning then succeeds on parent", () => {
    const parent = fakeModel("xai", "parent");
    const result = prepareAgentTask(
      agent({ tools: ["read"], model: "xai/noauth" }),
      runtime({
        parentModel: parent,
        modelRegistry: registry([
          { provider: "xai", id: "noauth", auth: false },
          { provider: "xai", id: "parent" },
        ]),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.source).toBe("parent");
    expect(result.prepared.modelId).toBe("xai/parent");
    expect(result.prepared.warnings.some((w) => /noauth/i.test(w))).toBe(true);
  });

  it("never invokes provider methods beyond registry find/auth checks", () => {
    const parent = fakeModel();
    const find = vi.fn((p: string, id: string) =>
      p === parent.provider && id === parent.id ? parent : undefined,
    );
    const hasConfiguredAuth = vi.fn((m: ParentModel) => m === parent);
    // Spy that would fail if anyone tried to "call a provider"
    const complete = vi.fn(() => {
      throw new Error("provider complete should never be called");
    });
    const reg = { find, hasConfiguredAuth, complete } as ModelRegistryLike & {
      complete: () => void;
    };

    const result = prepareAgentTask(
      agent({ tools: ["read"] }),
      runtime({ parentModel: parent, modelRegistry: reg }),
    );
    expect(result.ok).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it("always filters parent-inactive tools (no trusted mode)", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read", "write"] }),
      runtime({ activeTools: ["read"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.tools).toEqual(["read"]);
    expect(result.prepared.warnings.some((w) => /write/i.test(w))).toBe(true);
  });

  it("omitted tools request seven coding tools then intersect parent", () => {
    const result = prepareAgentTask(
      agent({ tools: undefined }),
      runtime({ activeTools: ["read"], projectTrusted: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.tools).toEqual(["read"]);
    expect(result.prepared.projectTrusted).toBe(false);
    expect(result.prepared.modelId).toBe("xai/m1");
    expect(result.prepared.warnings.filter((w) => /not active on the parent/i.test(w)).length).toBe(
      6,
    );
  });

  it("still rejects task and custom tools", () => {
    const result = prepareAgentTask(
      agent({ tools: ["read", "task", "intercom"] }),
      runtime({ activeTools: ["read"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.tools).toEqual(["read"]);
    expect(result.prepared.warnings.some((w) => /task/i.test(w))).toBe(true);
    expect(result.prepared.warnings.some((w) => /intercom/i.test(w))).toBe(true);
  });

  it("uses usable agent model via parent registry", () => {
    const parent = fakeModel("xai", "parent");
    const agentModel = fakeModel("xai", "special");
    const reg: ModelRegistryLike = {
      find(provider, id) {
        if (provider === "xai" && id === "special") return agentModel;
        if (provider === "xai" && id === "parent") return parent;
        return undefined;
      },
      hasConfiguredAuth(m) {
        return m === agentModel || m === parent;
      },
    };
    const result = prepareAgentTask(
      agent({ tools: ["read"], model: "xai/special" }),
      runtime({ parentModel: parent, modelRegistry: reg }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.source).toBe("frontmatter");
    expect(result.prepared.model).toBe(agentModel);
    expect(result.prepared.modelId).toBe("xai/special");
  });
});

describe("prepareAgentTaskOrThrow", () => {
  it("returns prepared on success", () => {
    const prepared = prepareAgentTaskOrThrow(agent({ tools: ["read"] }), runtime());
    expect(prepared.tools).toEqual(["read"]);
    expect(prepared.modelId).toBe("xai/m1");
  });

  it("throws with the failure error message", () => {
    expect(() => prepareAgentTaskOrThrow(agent({ tools: [] }), runtime())).toThrow(
      /explicitly empty/i,
    );
  });

  it("throws when active-tool API failed", () => {
    expect(() =>
      prepareAgentTaskOrThrow(
        agent({ tools: ["read"] }),
        runtime({ activeToolsApiFailed: true }),
      ),
    ).toThrow(ACTIVE_TOOLS_UNAVAILABLE_ERROR);
  });
});
