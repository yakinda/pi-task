import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/catalog.ts";
import {
  allAgentsCallable,
  buildBoundedCatalogSummary,
  buildTaskToolContract,
  buildToolDescription,
  collectStaticProviderFacingText,
  computeCatalogMetadataBudget,
  emptyCatalogMessage,
  formatAvailableAgents,
  formatEmptyCatalogError,
  formatUnknownAgentError,
  measureFixedProviderFacingOverhead,
  measureProviderFacingMetadata,
  TASK_CATALOG_DESCRIPTION_BUDGET,
  TASK_CATALOG_METADATA_BUDGET,
  TASK_ERROR_MESSAGE_BUDGET,
  TASK_PROMPT_GUIDELINES,
  TASK_PROMPT_SNIPPET,
  TASK_PROVIDER_METADATA_BUDGET,
  TASK_TOOL_DESCRIPTION_CORE,
  truncateDescription,
} from "../src/task-contract.ts";
import { normalizeAgentName } from "../src/catalog.ts";

function agent(
  name: string,
  description: string,
  filePath = `${name}.md`,
): AgentDefinition {
  return {
    name,
    description,
    body: "body",
    filePath,
  };
}

/** Exact policy facts that must appear exactly once across provider-facing metadata. */
const POLICY_FACTS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "direct-work",
    pattern:
      /Prefer direct read\/grep\/find for known files, symbols, or small search areas instead of Task/i,
  },
  {
    id: "no-fit-direct",
    pattern: /Do not use Task when no available Agent definition fits; use other tools directly/i,
  },
  {
    id: "no-duplicate",
    pattern: /do not duplicate the delegated work in the parent/i,
  },
  {
    id: "no-nesting",
    pattern: /Nested Task calls are unavailable inside Child Sessions/i,
  },
  {
    id: "concurrency-scope",
    pattern:
      /Launch concurrent Task calls only for independent research scopes or explicitly partitioned mutation scopes/i,
  },
  {
    id: "no-overlap-mutation",
    pattern: /Never run concurrent Task mutations that touch overlapping files or operations/i,
  },
];

/**
 * Semantic policy-concept detectors that catch paraphrased duplication, not
 * merely exact-regex of the guideline wording.
 *
 * Strategy: split the static surface into non-empty lines/sentences and count
 * how many *units* match any of the concept's phrase families. A single
 * guideline sentence that uses several related phrases still counts as one
 * unit; a tool-description paraphrase on a different unit is a second hit.
 */
type SemanticDetector = {
  id: string;
  /** Phrase families that all express the same policy concept. */
  families: RegExp[];
};

const SEMANTIC_POLICY_DETECTORS: SemanticDetector[] = [
  {
    id: "semantic-prefer-direct-tools",
    families: [
      /prefer\s+direct\s+read/i,
      /instead\s+of\s+Task/i,
      /skip\s+Task\s+for\s+known\s+files/i,
    ],
  },
  {
    id: "semantic-no-fit-use-other-tools",
    families: [
      /no\s+available\s+Agent\s+definition\s+fits/i,
      /use\s+other\s+tools\s+directly/i,
      /when\s+no\s+(?:Agent|agent)\s+fits/i,
    ],
  },
  {
    id: "semantic-no-duplicate-parent-work",
    families: [
      /do\s+not\s+duplicate\s+(?:the\s+)?delegated\s+work/i,
      /avoid\s+duplicat(?:e|ing)\s+(?:parent|delegated)\s+work/i,
      /continue\s+only\s+non-overlapping\s+work/i,
    ],
  },
  {
    id: "semantic-no-nesting",
    families: [
      /nested\s+Task/i,
      /no\s+nest(?:ed|ing)\s+Task/i,
      /Task\s+(?:calls?\s+)?unavailable\s+inside\s+Child\s+Sessions/i,
    ],
  },
  {
    id: "semantic-concurrency-independent-scope",
    // Catches the guideline and paraphrases such as
    // "Process concurrency is limited; prefer independent scopes when parallelizing".
    families: [
      /concurrent\s+Task\s+calls?\s+only\s+for\s+independent/i,
      /independent\s+research\s+scopes/i,
      /partitioned\s+mutation\s+scopes/i,
      /process\s+concurrency\s+is\s+limited/i,
      /prefer\s+independent\s+scopes/i,
      /independent\s+scopes?\s+when\s+paralleliz/i,
      /paralleliz\w*.{0,40}independent\s+scopes?/i,
    ],
  },
  {
    id: "semantic-no-overlap-mutation",
    families: [
      /never\s+run\s+concurrent\s+Task\s+mutations/i,
      /overlapping\s+files\s+or\s+operations/i,
      /concurrent\s+(?:Task\s+)?mutations?\s+that\s+touch\s+overlapping/i,
    ],
  },
];

function countMatches(haystack: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return [...haystack.matchAll(re)].length;
}

/** Split into line/sentence units so one multi-phrase guideline counts once. */
function policyUnits(surface: string): string[] {
  return surface
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Count how many distinct policy units express this concept. */
function countSemanticConceptUnits(haystack: string, families: RegExp[]): number {
  let units = 0;
  for (const unit of policyUnits(haystack)) {
    if (families.some((f) => f.test(unit))) units += 1;
  }
  return units;
}

describe("task contract — prompt snippet and guidelines", () => {
  it("prompt snippet is one line naming Task as specialized foreground delegation", () => {
    expect(TASK_PROMPT_SNIPPET).toMatch(/Task/i);
    expect(TASK_PROMPT_SNIPPET).toMatch(/foreground/i);
    expect(TASK_PROMPT_SNIPPET).not.toContain("\n");
    expect(TASK_PROMPT_SNIPPET.length).toBeLessThan(200);
  });

  it("every guideline explicitly names the Task tool", () => {
    expect(TASK_PROMPT_GUIDELINES.length).toBeGreaterThanOrEqual(5);
    for (const g of TASK_PROMPT_GUIDELINES) {
      expect(g).toMatch(/Task/);
    }
  });

  it("guidelines cover required policy facts", () => {
    const joined = TASK_PROMPT_GUIDELINES.join("\n");
    expect(joined).toMatch(/direct read|grep|find/i);
    expect(joined).toMatch(/do not duplicate/i);
    expect(joined).toMatch(/Nested Task/i);
    expect(joined).toMatch(/independent research|partitioned mutation/i);
    expect(joined).toMatch(/overlapping files or operations/i);
  });
});

describe("task contract — policy facts appear exactly once", () => {
  it("each exact policy fact appears exactly once across provider-facing static metadata", () => {
    const surface = collectStaticProviderFacingText();
    for (const fact of POLICY_FACTS) {
      const n = countMatches(surface, fact.pattern);
      expect(n, `policy fact "${fact.id}" count`).toBe(1);
    }
  });

  it("each semantic policy concept appears in exactly one policy unit (catches paraphrased duplication)", () => {
    const surface = collectStaticProviderFacingText();
    for (const fact of SEMANTIC_POLICY_DETECTORS) {
      const n = countSemanticConceptUnits(surface, fact.families);
      expect(
        n,
        `semantic policy fact "${fact.id}" must appear in exactly one unit (got ${n})`,
      ).toBe(1);
    }
  });

  it("catches paraphrased concurrency duplication if reintroduced into tool description core", () => {
    // Regression guard for the known Issue 8 gap: a tool-description paraphrase
    // of the concurrent-independent-scope guideline must not coexist with it.
    const paraphrase =
      "Process concurrency is limited; prefer independent scopes when parallelizing.";
    const polluted = `${collectStaticProviderFacingText()}\n${paraphrase}`;
    const detector = SEMANTIC_POLICY_DETECTORS.find(
      (d) => d.id === "semantic-concurrency-independent-scope",
    )!;
    expect(countSemanticConceptUnits(polluted, detector.families)).toBeGreaterThan(1);
    // Clean surface still exactly once.
    expect(
      countSemanticConceptUnits(collectStaticProviderFacingText(), detector.families),
    ).toBe(1);
  });

  it("tool description core does not restate guideline policy (including paraphrases)", () => {
    // Nested / concurrency / no-duplicate / direct-work live in guidelines only.
    expect(TASK_TOOL_DESCRIPTION_CORE).not.toMatch(/Nested Task/i);
    expect(TASK_TOOL_DESCRIPTION_CORE).not.toMatch(/overlapping files/i);
    expect(TASK_TOOL_DESCRIPTION_CORE).not.toMatch(/do not duplicate/i);
    expect(TASK_TOOL_DESCRIPTION_CORE).not.toMatch(/Prefer direct read/i);
    // Semantic: no concurrency / parallel / independent-scope paraphrase in core.
    expect(TASK_TOOL_DESCRIPTION_CORE).not.toMatch(
      /concurrent|paralleliz|independent\s+scopes?|process\s+concurrency/i,
    );
  });

  it("full contract with agents still has each fact once in static surfaces", () => {
    const contract = buildTaskToolContract([
      agent("explore", "Fast codebase search"),
      agent("reviewer", "Read-only review"),
    ]);
    // Static surfaces only (exclude catalog agent lines which may contain words).
    const surface = [
      contract.description.slice(0, TASK_TOOL_DESCRIPTION_CORE.length),
      contract.promptSnippet,
      ...contract.promptGuidelines,
      contract.parameterDescriptions.description,
      contract.parameterDescriptions.prompt,
      contract.parameterDescriptions.subagent_type,
    ].join("\n");
    for (const fact of POLICY_FACTS) {
      expect(countMatches(surface, fact.pattern), fact.id).toBe(1);
    }
    for (const fact of SEMANTIC_POLICY_DETECTORS) {
      expect(countSemanticConceptUnits(surface, fact.families), fact.id).toBe(1);
    }
  });
});

describe("task contract — total provider metadata hard budget", () => {
  it("fixed overhead leaves room for a Catalog block under the total budget", () => {
    const fixed = measureFixedProviderFacingOverhead();
    const catalogBudget = computeCatalogMetadataBudget();
    expect(fixed).toBeLessThan(TASK_PROVIDER_METADATA_BUDGET);
    expect(catalogBudget).toBeGreaterThan(0);
    expect(catalogBudget).toBeLessThanOrEqual(TASK_CATALOG_METADATA_BUDGET);
    expect(fixed + catalogBudget).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
  });

  it("empty Catalog totalChars stays within TASK_PROVIDER_METADATA_BUDGET", () => {
    const measured = measureProviderFacingMetadata([]);
    expect(measured.totalChars).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
    expect(measured.catalogChars).toBeLessThanOrEqual(measured.catalogBudget);
    expect(measured.contract.description).toMatch(/No Agent definitions/i);
  });

  it("representative Catalog totalChars stays within TASK_PROVIDER_METADATA_BUDGET", () => {
    const agents = [
      agent("explore", "Fast read-only codebase discovery and symbol search"),
      agent("reviewer", "Read-only review of diffs and potential issues"),
      agent("general", "General multi-step coding bounded by parent tools"),
    ];
    const measured = measureProviderFacingMetadata(agents);
    expect(measured.totalChars).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
    expect(measured.catalogChars).toBeLessThanOrEqual(TASK_CATALOG_METADATA_BUDGET);
    expect(measured.catalogChars).toBeLessThanOrEqual(measured.catalogBudget);
    expect(measured.contract.catalogSummary.includedNames).toEqual([
      "explore",
      "general",
      "reviewer",
    ]);
    expect(measured.contract.catalogSummary.omittedCount).toBe(0);
    // Materially smaller than ~2020 char baseline with two agents of static bloat.
    expect(measured.descriptionChars).toBeLessThan(1400);
  });

  it("200+ agent Catalog totalChars stays within TASK_PROVIDER_METADATA_BUDGET", () => {
    const agents = Array.from({ length: 200 }, (_, i) =>
      agent(
        `agent${String(i).padStart(3, "0")}`,
        `Very long description of agent ${i} that would otherwise bloat every request `.repeat(3),
      ),
    );
    const measured = measureProviderFacingMetadata(agents);
    expect(measured.totalChars).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
    expect(measured.catalogChars).toBeLessThanOrEqual(measured.catalogBudget);
    expect(measured.catalogChars).toBeLessThanOrEqual(TASK_CATALOG_METADATA_BUDGET);
    expect(measured.contract.catalogSummary.omittedCount).toBeGreaterThan(0);
    expect(measured.contract.catalogSummary.text).toMatch(/\+\d+ more agent/);
    // Description-first / name-preserving: earliest names by locale order remain.
    expect(measured.contract.catalogSummary.includedNames[0]).toBe("agent000");
    expect(measured.contract.catalogSummary.includedNames.length).toBeGreaterThan(0);
  });
});

describe("task contract — Catalog summary budgets", () => {
  it("empty Catalog message is helpful, bounded, deterministic", () => {
    const a = emptyCatalogMessage();
    const b = emptyCatalogMessage();
    expect(a).toBe(b);
    expect(a).toMatch(/Agent definition/i);
    expect(a).toMatch(/new session|agents\//i);
    expect(a).not.toMatch(/task-agents|task-init|aliases|tags|skills/i);
    expect(a.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);

    const summary = buildBoundedCatalogSummary([]);
    expect(summary.text).toContain(a.slice(0, 40));
    expect(summary.includedNames).toEqual([]);
    expect(summary.omittedCount).toBe(0);

    const measured = measureProviderFacingMetadata([]);
    expect(measured.totalChars).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
    expect(measured.contract.description).toMatch(/No Agent definitions/i);
  });

  it("truncates long descriptions before dropping canonical names", () => {
    const long = "x".repeat(TASK_CATALOG_DESCRIPTION_BUDGET + 80);
    const agents = [agent("alpha", long), agent("beta", "short")];
    const summary = buildBoundedCatalogSummary(agents);
    expect(summary.includedNames).toEqual(["alpha", "beta"]);
    expect(summary.omittedCount).toBe(0);
    expect(summary.truncatedDescriptions).toBe(true);
    expect(summary.text).toContain("alpha");
    expect(summary.text).toContain("beta");
    const alphaLine = summary.text.split("\n").find((l) => l.includes("alpha"))!;
    expect(alphaLine.length).toBeLessThan(long.length);
    expect(alphaLine).toMatch(/…$/);
  });

  it("preserves canonical names as long as possible under tight budget", () => {
    const agents = Array.from({ length: 20 }, (_, i) =>
      agent(`agent${String(i).padStart(2, "0")}`, `Description number ${i} with some detail`),
    );
    // Force name-only phase by tight total budget that cannot fit all descriptions.
    const summary = buildBoundedCatalogSummary(agents, {
      descriptionBudget: 40,
      metadataBudget: 280,
    });
    expect(summary.text.length).toBeLessThanOrEqual(280);
    // At least some names included
    expect(summary.includedNames.length).toBeGreaterThan(0);
    // Every included line is name-bearing
    for (const name of summary.includedNames) {
      expect(summary.text).toContain(name);
    }
    if (summary.omittedCount > 0) {
      expect(summary.text).toMatch(/\+\d+ more agent/);
    }
  });

  it("huge Catalog respects catalog metadata budget and may omit trailing names", () => {
    const agents = Array.from({ length: 200 }, (_, i) =>
      agent(
        `agent${String(i).padStart(3, "0")}`,
        `Very long description of agent ${i} that would otherwise bloat every request `.repeat(3),
      ),
    );
    const summary = buildBoundedCatalogSummary(agents);
    expect(summary.text.length).toBeLessThanOrEqual(TASK_CATALOG_METADATA_BUDGET);
    expect(summary.omittedCount).toBeGreaterThan(0);
    expect(summary.text).toMatch(/\+\d+ more agent/);
    expect(summary.includedNames[0]).toBe("agent000");
  });

  it("extreme tiny budgets remain valid, deterministic, and within budget", () => {
    const agents = Array.from({ length: 30 }, (_, i) =>
      agent(`z${String(i).padStart(2, "0")}`, `desc ${i}`),
    );
    for (const budget of [1, 10, 25, 40, 60]) {
      const a = buildBoundedCatalogSummary(agents, { metadataBudget: budget });
      const b = buildBoundedCatalogSummary(agents, { metadataBudget: budget });
      expect(a.text).toBe(b.text);
      expect(a.text.length).toBeLessThanOrEqual(budget);
      expect(a.omittedCount + a.includedNames.length).toBe(agents.length);
      // Marker may be hard-truncated under extreme budgets but must not throw.
      if (a.omittedCount > 0 && a.text.length >= 20) {
        // When there is room, omitted marker should appear (possibly truncated).
        expect(a.text).toMatch(/\+|more agent|…/);
      }
    }
  });

  it("description-first then name-preserving under progressive budget pressure", () => {
    const agents = [
      agent("alpha", "Alpha does thorough research across the whole tree"),
      agent("beta", "Beta reviews carefully"),
      agent("gamma", "Gamma implements changes"),
    ];
    // Generous: descriptions retained
    const generous = buildBoundedCatalogSummary(agents, { metadataBudget: 500 });
    expect(generous.omittedCount).toBe(0);
    expect(generous.includedNames).toEqual(["alpha", "beta", "gamma"]);
    expect(generous.text).toMatch(/alpha:/);

    // Medium: names kept, descriptions may drop
    const medium = buildBoundedCatalogSummary(agents, {
      descriptionBudget: 80,
      metadataBudget: 70,
    });
    expect(medium.includedNames.length).toBeGreaterThan(0);
    expect(medium.omittedCount + medium.includedNames.length).toBe(3);
    for (const name of medium.includedNames) {
      expect(medium.text).toContain(name);
    }

    // Tiny: some names omitted with marker (or hard-truncated marker).
    // "Available agents:\n- alpha\n- beta\n- gamma" is ~40 chars, so 32 forces omission.
    const tiny = buildBoundedCatalogSummary(agents, { metadataBudget: 32 });
    expect(tiny.text.length).toBeLessThanOrEqual(32);
    expect(tiny.omittedCount).toBeGreaterThan(0);
  });

  it("deterministic ordering independent of input order", () => {
    const a = [agent("zeta", "Z"), agent("alpha", "A"), agent("mu", "M")];
    const b = [agent("mu", "M"), agent("zeta", "Z"), agent("alpha", "A")];
    expect(buildBoundedCatalogSummary(a).text).toBe(buildBoundedCatalogSummary(b).text);
    expect(buildToolDescription(a)).toBe(buildToolDescription(b));
  });
});

describe("task contract — human Catalog descriptions unchanged", () => {
  it("does not truncate human-visible Catalog listings", () => {
    const long = "full-description-".repeat(20);
    const listing = formatAvailableAgents([agent("keep", long)]);
    expect(listing).toContain(long);
    expect(listing).toContain("keep");
  });
});

describe("task contract — canonical names under metadata budget", () => {
  it("keeps total provider metadata within budget for large Catalogs", () => {
    const agents = Array.from({ length: 40 }, (_, i) =>
      agent(
        `agent${String(i).padStart(2, "0")}`,
        `Description for specialist agent ${i} with useful detail `.repeat(4),
        `agent${i}.md`,
      ),
    );
    const measured = measureProviderFacingMetadata(agents);
    expect(measured.totalChars).toBeLessThanOrEqual(TASK_PROVIDER_METADATA_BUDGET);
    expect(measured.catalogChars).toBeLessThanOrEqual(measured.catalogBudget);
  });

  it("retains canonical names before descriptions under pressure", () => {
    const agents = [
      agent("alpha", "Alpha does thorough research", "a.md"),
      agent("beta", "Beta reviews carefully", "b.md"),
      agent("gamma", "Gamma implements changes", "c.md"),
    ];

    const summary = buildBoundedCatalogSummary(agents, {
      descriptionBudget: 80,
      metadataBudget: 90,
    });
    expect(summary.text.length).toBeLessThanOrEqual(90);
    for (const name of summary.includedNames) {
      expect(summary.text).toContain(name);
    }

    // Tighter: force name-only path; names must remain.
    const tight = buildBoundedCatalogSummary(agents, {
      descriptionBudget: 40,
      metadataBudget: 55,
    });
    expect(tight.text.length).toBeLessThanOrEqual(55);
    expect(tight.includedNames.length).toBeGreaterThan(0);
    expect(tight.includedNames[0]).toBe("alpha");
    expect(tight.text).not.toMatch(/aliases:|tags:|skills:/);
  });

  it("unknown-agent guidance recommends canonical names only", () => {
    const agents = [
      agent("Explore", "Fast codebase lookup", "e.md"),
      agent("Reviewer", "Reviews code", "r.md"),
    ];
    const msg = formatUnknownAgentError("nope", agents);
    expect(msg).toContain("Explore");
    expect(msg).toContain("Reviewer");
    expect(msg).not.toMatch(/aliases:|tags:|skills:|\/task-init|\/task-agents/);
    expect(msg.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);
  });
});

describe("task contract — unknown and empty errors", () => {
  it("empty Catalog error is bounded and helpful", () => {
    const msg = formatEmptyCatalogError("Explore");
    expect(msg).toMatch(/Explore/);
    expect(msg).toMatch(/Agent definition|agents\//i);
    expect(msg.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);
  });

  it("unknown agent error lists bounded catalog and is deterministic", () => {
    const agents = [
      agent("explore", "Fast search"),
      agent("reviewer", "Reviews code carefully with lots of extra wording ".repeat(10)),
    ];
    const a = formatUnknownAgentError("nope", agents);
    const b = formatUnknownAgentError("nope", agents);
    expect(a).toBe(b);
    expect(a).toContain("nope");
    expect(a).toContain("explore");
    expect(a).toContain("reviewer");
    expect(a.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);
  });

  it("unknown agent with empty catalog falls back to empty message", () => {
    const msg = formatUnknownAgentError("x", []);
    expect(msg).toMatch(/No Agent definitions|Requested: x/i);
    expect(msg.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);
  });

  it("bounds a hostile requested name without crowding out available canonical names", () => {
    const requested = `bad\nname ${"x".repeat(2_000)}`;
    const msg = formatUnknownAgentError(requested, [
      agent("explore", "Fast search"),
      agent("reviewer", "Read-only review"),
    ]);
    expect(msg.length).toBeLessThanOrEqual(TASK_ERROR_MESSAGE_BUDGET);
    expect(msg).not.toContain("\nname");
    expect(msg).toContain("explore");
    expect(msg).toContain("reviewer");
  });
});

describe("task contract — case-insensitive callability", () => {
  it("all agents remain callable even when not fully advertised", () => {
    const agents = Array.from({ length: 80 }, (_, i) =>
      agent(`Role${i}`, `desc ${i} `.repeat(30)),
    );
    const byKey = new Map(agents.map((a) => [normalizeAgentName(a.name), a]));
    const find = (name: string) => byKey.get(normalizeAgentName(name));

    const summary = buildBoundedCatalogSummary(agents, { metadataBudget: 200 });
    // Some may be omitted from advertisement
    expect(summary.omittedCount + summary.includedNames.length).toBe(agents.length);

    // All remain callable case-insensitively regardless of advertisement
    expect(allAgentsCallable(agents, find)).toBe(true);
    for (const a of agents) {
      expect(find(a.name.toLowerCase())?.name).toBe(a.name);
      expect(find(a.name.toUpperCase())?.name).toBe(a.name);
    }
  });
});

describe("task contract — truncateDescription", () => {
  it("leaves short text intact and marks long text", () => {
    expect(truncateDescription("short", 20)).toEqual({ text: "short", truncated: false });
    const r = truncateDescription("abcdefghij", 5);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(5);
    expect(r.text.endsWith("…")).toBe(true);
  });
});

describe("task contract — extension-facing registration shape", () => {
  it("buildTaskToolContract exposes snippet, guidelines, and params", () => {
    const contract = buildTaskToolContract([agent("explore", "Fast")]);
    expect(contract.promptSnippet).toBe(TASK_PROMPT_SNIPPET);
    expect(contract.promptGuidelines).toEqual(TASK_PROMPT_GUIDELINES);
    expect(contract.parameterDescriptions.subagent_type).toMatch(/case-insensitive/i);
    expect(contract.description).toContain("explore");
    expect(contract.description).toContain(TASK_TOOL_DESCRIPTION_CORE.slice(0, 20));
  });
});
