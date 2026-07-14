import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Parent model object as exposed by Pi ExtensionContext. */
export type ParentModel = NonNullable<ExtensionContext["model"]>;

/** Thinking levels from Pi ExtensionAPI (includes `max` on current SDK). */
export type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Thinking levels accepted by current Pi (includes `max`). */
export const THINKING_LEVELS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Cascade source for the resolved child model (Agent frontmatter, then parent). */
export type ModelSource = "frontmatter" | "parent";

export interface AgentModelFields {
  name: string;
  model?: string;
  thinking?: string;
}

/** Minimal model registry surface needed for cascade checks. */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): ParentModel | undefined;
  hasConfiguredAuth(model: ParentModel): boolean;
}

export interface ParentModelContext {
  /** Exact parent model object when known (final cascade candidate). */
  parentModel?: ParentModel;
  modelRegistry?: ModelRegistryLike;
  parentThinking?: PiThinkingLevel;
}

export interface ResolveModelResult {
  model: ParentModel;
  source: ModelSource;
  thinking?: PiThinkingLevel;
  warnings: string[];
  /** Strict provider/modelId of the chosen model. */
  modelId: string;
}

/**
 * Model cascade (strict provider/modelId):
 * 1. Agent frontmatter model (when usable through the parent ModelRegistry)
 * 2. Exact parent model object
 *
 * A candidate is usable only when it has a strict ID, exists in the parent
 * ModelRegistry, and has configured auth. Parent model is used by identity
 * without re-parsing through a new registry.
 *
 * No settings.subagents defaults or per-Agent overrides are consulted.
 */
export function resolveModel(
  agent: AgentModelFields,
  parent: ParentModelContext,
): ResolveModelResult {
  const warnings: string[] = [];
  type Candidate =
    | { kind: "id"; modelId: string; source: "frontmatter" }
    | { kind: "object"; model: ParentModel; source: "parent" };

  const candidates: Candidate[] = [];

  if (agent.model) {
    candidates.push({ kind: "id", modelId: agent.model, source: "frontmatter" });
  }

  if (parent.parentModel) {
    candidates.push({ kind: "object", model: parent.parentModel, source: "parent" });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not resolve a model for agent "${agent.name}": no candidates ` +
        "(agent model or parent model).",
    );
  }

  for (const candidate of candidates) {
    if (candidate.kind === "object") {
      const model = candidate.model;
      const modelId = `${model.provider}/${model.id}`;
      if (!parent.modelRegistry) {
        warnings.push(
          `Skipped model ${modelId} (parent): no parent model registry available`,
        );
        continue;
      }
      if (!parent.modelRegistry.hasConfiguredAuth(model)) {
        warnings.push(
          `Skipped model ${modelId} (parent): no configured auth/runtime credentials`,
        );
        continue;
      }
      return {
        model,
        source: "parent",
        thinking: resolveThinking(agent, parent),
        warnings,
        modelId,
      };
    }

    const raw = candidate.modelId.trim();
    if (!isStrictProviderModelId(raw)) {
      warnings.push(
        `Skipped model "${candidate.modelId}" (${candidate.source}): not a strict provider/modelId`,
      );
      continue;
    }

    const slash = raw.indexOf("/");
    const provider = raw.slice(0, slash);
    const id = raw.slice(slash + 1);

    if (!parent.modelRegistry) {
      // Without a registry we cannot prove existence/auth; only parent object is safe.
      warnings.push(
        `Skipped model ${raw} (${candidate.source}): no parent model registry available`,
      );
      continue;
    }

    const found = parent.modelRegistry.find(provider, id);
    if (!found) {
      warnings.push(
        `Skipped model ${raw} (${candidate.source}): not found in parent model registry`,
      );
      continue;
    }

    if (!parent.modelRegistry.hasConfiguredAuth(found)) {
      warnings.push(
        `Skipped model ${raw} (${candidate.source}): no configured auth/runtime credentials`,
      );
      continue;
    }

    return {
      model: found,
      source: candidate.source,
      thinking: resolveThinking(agent, parent),
      warnings,
      modelId: raw,
    };
  }

  throw new Error(
    `Could not resolve a usable model for agent "${agent.name}". ` +
      `Tried: ${candidates
        .map((c) => (c.kind === "id" ? `${c.modelId} (${c.source})` : `parent model (${c.source})`))
        .join(", ")}. ` +
      (warnings.length ? `Warnings: ${warnings.join("; ")}` : "Use strict provider/modelId form."),
  );
}

export function resolveThinking(
  agent: AgentModelFields,
  parent: ParentModelContext,
): PiThinkingLevel | undefined {
  if (agent.thinking && isThinkingLevel(agent.thinking)) {
    return agent.thinking as PiThinkingLevel;
  }
  return parent.parentThinking;
}

export function isThinkingLevel(value: string): value is PiThinkingLevel {
  return THINKING_LEVELS.has(value.trim().toLowerCase());
}

export function isStrictProviderModelId(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash <= 0) return false;
  if (slash === value.length - 1) return false;
  if (value !== value.trim()) return false;
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  return provider.length > 0 && modelId.length > 0 && !provider.includes(" ") && !modelId.startsWith("/");
}
