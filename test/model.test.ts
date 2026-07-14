import { describe, expect, it } from "vitest";
import {
  isStrictProviderModelId,
  isThinkingLevel,
  resolveModel,
  resolveThinking,
  type ModelRegistryLike,
  type ParentModel,
  type ParentModelContext,
} from "../src/model.ts";

function fakeModel(provider: string, id: string): ParentModel {
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

function registry(opts: {
  models: Array<{ provider: string; id: string; auth?: boolean }>;
}): ModelRegistryLike {
  const map = new Map(
    opts.models.map((m) => [`${m.provider}/${m.id}`, { model: fakeModel(m.provider, m.id), auth: m.auth !== false }]),
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

const agent = (over: { name?: string; model?: string; thinking?: string } = {}) => ({
  name: over.name ?? "explore",
  model: over.model,
  thinking: over.thinking,
});

describe("isStrictProviderModelId", () => {
  it("accepts provider/modelId", () => {
    expect(isStrictProviderModelId("xai-oauth/grok-4.5")).toBe(true);
    expect(isStrictProviderModelId("anthropic/claude-opus-4-5")).toBe(true);
  });

  it("rejects bare or invalid forms", () => {
    expect(isStrictProviderModelId("grok-4.5")).toBe(false);
    expect(isStrictProviderModelId("/model")).toBe(false);
    expect(isStrictProviderModelId("provider/")).toBe(false);
    expect(isStrictProviderModelId("")).toBe(false);
  });
});

describe("isThinkingLevel", () => {
  it("accepts max and xhigh", () => {
    expect(isThinkingLevel("max")).toBe(true);
    expect(isThinkingLevel("xhigh")).toBe(true);
    expect(isThinkingLevel("nope")).toBe(false);
  });
});

describe("resolveModel cascade", () => {
  const parentModel = fakeModel("a", "parent");
  const baseRegistry = registry({
    models: [
      { provider: "a", id: "front" },
      { provider: "a", id: "parent" },
      { provider: "a", id: "ok" },
      { provider: "a", id: "missing", auth: false },
    ],
  });

  // Ensure parent model is recognized for auth when used by identity
  const parent: ParentModelContext = {
    parentModel,
    modelRegistry: {
      find: baseRegistry.find.bind(baseRegistry),
      hasConfiguredAuth: (m) => {
        if (m === parentModel) return true;
        return baseRegistry.hasConfiguredAuth(m);
      },
    },
  };

  it("frontmatter wins when usable", () => {
    const result = resolveModel(agent({ model: "a/front" }), parent);
    expect(result.modelId).toBe("a/front");
    expect(result.source).toBe("frontmatter");
    expect(result.model).toBe(baseRegistry.find("a", "front"));
  });

  it("exact parent model fallback (identity)", () => {
    const result = resolveModel(agent(), parent);
    expect(result.source).toBe("parent");
    expect(result.model).toBe(parentModel);
    expect(result.modelId).toBe("a/parent");
  });

  it("invalid ID → warning + parent fallback", () => {
    const result = resolveModel(agent({ model: "not-strict" }), parent);
    expect(result.modelId).toBe("a/parent");
    expect(result.source).toBe("parent");
    expect(result.warnings.some((w) => /not a strict/.test(w))).toBe(true);
  });

  it("missing registry model → warning + parent fallback", () => {
    const result = resolveModel(agent({ model: "a/nope" }), parent);
    expect(result.modelId).toBe("a/parent");
    expect(result.source).toBe("parent");
    expect(result.warnings.some((w) => /not found/.test(w))).toBe(true);
  });

  it("missing auth on agent model → warning + parent fallback", () => {
    const result = resolveModel(agent({ model: "a/missing" }), parent);
    expect(result.modelId).toBe("a/parent");
    expect(result.source).toBe("parent");
    expect(result.warnings.some((w) => /no configured auth/.test(w))).toBe(true);
  });

  it("all candidates unavailable → error", () => {
    expect(() =>
      resolveModel(agent({ model: "bad" }), {
        modelRegistry: baseRegistry,
      }),
    ).toThrow(/Could not resolve a usable model/);
  });

  it("missing parent model with no agent model → error", () => {
    expect(() =>
      resolveModel(agent(), {
        modelRegistry: baseRegistry,
      }),
    ).toThrow(/no candidates/);
  });

  it("parent model without configured credentials → error", () => {
    const unauthParent = fakeModel("a", "parent");
    expect(() =>
      resolveModel(agent(), {
        parentModel: unauthParent,
        modelRegistry: {
          find: baseRegistry.find.bind(baseRegistry),
          hasConfiguredAuth: () => false,
        },
      }),
    ).toThrow(/Could not resolve a usable model/);
  });

  it("resolved model object identity is preserved into result", () => {
    const found = baseRegistry.find("a", "front")!;
    const result = resolveModel(agent({ model: "a/front" }), parent);
    expect(result.model).toBe(found);
  });

  it("thinking: max from agent and parent", () => {
    expect(
      resolveThinking(agent({ thinking: "max" }), { parentThinking: "low" }),
    ).toBe("max");
    expect(resolveThinking(agent(), { parentThinking: "max" })).toBe("max");
  });

  it("invalid agent thinking inherits parent level", () => {
    expect(
      resolveThinking(agent({ thinking: "nope" }), { parentThinking: "high" }),
    ).toBe("high");
  });
});
