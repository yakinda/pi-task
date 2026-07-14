import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildToolDescription,
  formatAvailableAgents,
  loadAgentCatalog,
  loadAgentCatalogWithStatus,
  parseAgentFile,
} from "../src/catalog.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-catalog-"));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, name: string, content: string) {
  fs.writeFileSync(path.join(dir, name), content);
}

describe("parseAgentFile", () => {
  it("parses real YAML quotes/comments/inline and block arrays", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
# comment
name: "explore"
description: 'Fast search'
tools:
  - read
  - grep
thinking: low
model: xai-oauth/grok-code-fast-1
---

You are a search specialist.
`,
      "/tmp/explore.md",
    );
    expect(diagnostics).toEqual([]);
    expect(agent).toMatchObject({
      name: "explore",
      description: "Fast search",
      tools: ["read", "grep"],
      thinking: "low",
      model: "xai-oauth/grok-code-fast-1",
      body: "You are a search specialist.",
    });
    expect(agent).not.toHaveProperty("aliases");
    expect(agent).not.toHaveProperty("tags");
    expect(agent).not.toHaveProperty("skills");
  });

  it("parses comma-separated tools string", () => {
    const { agent } = parseAgentFile(
      `---
name: a
description: b
tools: read, grep, find
---
body
`,
      "a.md",
    );
    expect(agent?.tools).toEqual(["read", "grep", "find"]);
  });

  it("missing required fields → diagnostic", () => {
    expect(parseAgentFile("---\nname: x\n---\nbody", "a.md").diagnostics[0]?.code).toBe(
      "agent_missing_description",
    );
    expect(parseAgentFile("---\ndescription: y\n---\nbody", "b.md").diagnostics[0]?.code).toBe(
      "agent_missing_name",
    );
    expect(parseAgentFile("no frontmatter", "c.md").diagnostics[0]?.code).toBe(
      "agent_no_frontmatter",
    );
    expect(
      parseAgentFile("---\nname: a\ndescription: b\n---\n   \n", "d.md").diagnostics[0]?.code,
    ).toBe("agent_missing_body");
  });

  it("invalid thinking is omitted with diagnostic (definition retained)", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: a
description: b
thinking: superhigh
---
body
`,
      "a.md",
    );
    expect(agent?.name).toBe("a");
    expect(agent?.thinking).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "agent_invalid_thinking")).toBe(true);
  });

  it("accepts thinking: max", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: a
description: b
thinking: max
---
body
`,
      "a.md",
    );
    expect(diagnostics).toEqual([]);
    expect(agent?.thinking).toBe("max");
  });

  it("preserves explicit empty tools and distinguishes from omitted", () => {
    const empty = parseAgentFile(
      `---
name: a
description: b
tools: []
---
body
`,
      "a.md",
    );
    expect(empty.agent?.tools).toEqual([]);

    const omitted = parseAgentFile(
      `---
name: a
description: b
---
body
`,
      "a.md",
    );
    expect(omitted.agent?.tools).toBeUndefined();
  });

  it("malformed tools or non-string list members reject the definition", () => {
    const explicitNull = parseAgentFile(
      `---
name: a
description: b
tools: null
---
body
`,
      "a.md",
    );
    expect(explicitNull.agent).toBeUndefined();
    expect(explicitNull.diagnostics.some((d) => d.code === "agent_invalid_tools")).toBe(true);

    const nonString = parseAgentFile(
      `---
name: a
description: b
tools: [read, 42]
---
body
`,
      "a.md",
    );
    expect(nonString.agent).toBeUndefined();
    expect(nonString.diagnostics.some((d) => d.code === "agent_invalid_tools")).toBe(true);

    const wrongType = parseAgentFile(
      `---
name: a
description: b
tools: 42
---
body
`,
      "a.md",
    );
    expect(wrongType.agent).toBeUndefined();
    expect(wrongType.diagnostics.some((d) => d.code === "agent_invalid_tools")).toBe(true);
  });

  it("invalid or empty model is omitted with diagnostic (definition retained)", () => {
    const empty = parseAgentFile(
      `---
name: a
description: b
model: ""
---
body
`,
      "a.md",
    );
    expect(empty.agent?.name).toBe("a");
    expect(empty.agent?.model).toBeUndefined();
    expect(empty.diagnostics.some((d) => d.code === "agent_invalid_model")).toBe(true);

    const wrongType = parseAgentFile(
      `---
name: a
description: b
model: 12
---
body
`,
      "a.md",
    );
    expect(wrongType.agent?.name).toBe("a");
    expect(wrongType.agent?.model).toBeUndefined();
    expect(wrongType.diagnostics.some((d) => d.code === "agent_invalid_model")).toBe(true);

    const explicitNull = parseAgentFile(
      `---
name: a
description: b
model: null
---
body
`,
      "a.md",
    );
    expect(explicitNull.agent?.model).toBeUndefined();
    expect(explicitNull.diagnostics.some((d) => d.code === "agent_invalid_model")).toBe(true);
  });

  it("invalid thinking null is omitted with a diagnostic", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: a
description: b
thinking: null
---
body
`,
      "a.md",
    );
    expect(agent?.thinking).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "agent_invalid_thinking")).toBe(true);
  });

  it("removed aliases/tags/skills produce migration diagnostics without discarding definition", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: explore
description: Fast search
aliases: [search]
tags: [research]
skills: [librarian]
tools: read, grep
---
You search.
`,
      "explore.md",
    );
    expect(agent).toMatchObject({
      name: "explore",
      description: "Fast search",
      tools: ["read", "grep"],
      body: "You search.",
    });
    expect(agent).not.toHaveProperty("aliases");
    expect(agent).not.toHaveProperty("tags");
    expect(agent).not.toHaveProperty("skills");
    expect(diagnostics.map((d) => d.code).sort()).toEqual([
      "agent_removed_field_aliases",
      "agent_removed_field_skills",
      "agent_removed_field_tags",
    ]);
    for (const d of diagnostics) {
      expect(d.message).toMatch(/no longer supported|ignored|Remove/i);
    }

    const nullFields = parseAgentFile(
      `---
name: minimal
description: Minimal
aliases: null
tags: null
skills: null
---
body
`,
      "minimal.md",
    );
    expect(nullFields.agent?.name).toBe("minimal");
    expect(nullFields.diagnostics.map((d) => d.code).sort()).toEqual([
      "agent_removed_field_aliases",
      "agent_removed_field_skills",
      "agent_removed_field_tags",
    ]);
  });

  it("unsupported/custom tools and nested task produce discovery diagnostics while keeping definition", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: a
description: b
tools: read, task, my_custom, grep
---
body
`,
      "a.md",
    );
    expect(agent?.tools).toEqual(["read", "task", "my_custom", "grep"]);
    expect(diagnostics.some((d) => d.code === "agent_nested_task_tool")).toBe(true);
    expect(diagnostics.some((d) => d.code === "agent_unsupported_tool" && /my_custom/.test(d.message))).toBe(
      true,
    );
    // Valid built-ins remain on the definition for runtime re-filter.
    expect(agent?.tools).toContain("read");
    expect(agent?.tools).toContain("grep");
  });

  it("ignores unknown unrelated frontmatter fields", () => {
    const { agent, diagnostics } = parseAgentFile(
      `---
name: a
description: b
color: red
permission: all
---
body
`,
      "a.md",
    );
    expect(diagnostics).toEqual([]);
    expect(agent?.name).toBe("a");
  });
});

describe("loadAgentCatalog", () => {
  it("loads valid agents and diagnostics for invalid files", () => {
    const dir = tempDir();
    write(
      dir,
      "explore.md",
      `---
name: explore
description: Fast search
---
body
`,
    );
    write(dir, "broken.md", "not an agent");
    write(dir, "readme.txt", "ignore");

    const snap = loadAgentCatalog(dir);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].name).toBe("explore");
    expect(snap.diagnostics.some((d) => d.path?.endsWith("broken.md"))).toBe(true);
  });

  it("valid agents still load when other files error", () => {
    const dir = tempDir();
    write(
      dir,
      "good.md",
      `---
name: good
description: ok
---
g
`,
    );
    write(
      dir,
      "bad.md",
      `---
name: bad
---
b
`,
    );
    const snap = loadAgentCatalog(dir);
    expect(snap.agents.map((a) => a.name)).toEqual(["good"]);
    expect(snap.diagnostics.some((d) => d.code === "agent_missing_description")).toBe(true);
  });

  it("Explore + explore → both dropped as conflict", () => {
    const dir = tempDir();
    write(
      dir,
      "A.md",
      `---
name: Explore
description: A
---
a
`,
    );
    write(
      dir,
      "B.md",
      `---
name: explore
description: B
---
b
`,
    );
    const snap = loadAgentCatalog(dir);
    expect(snap.agents).toHaveLength(0);
    expect(snap.diagnostics.some((d) => d.code === "agent_name_conflict")).toBe(true);
  });

  it("non-conflicting definitions remain; conflict diagnostics are deterministic", () => {
    const dir = tempDir();
    write(
      dir,
      "keep.md",
      `---
name: keeper
description: Safe
---
keep
`,
    );
    write(
      dir,
      "z-conflict.md",
      `---
name: Clash
description: Z
---
z
`,
    );
    write(
      dir,
      "a-conflict.md",
      `---
name: clash
description: A
---
a
`,
    );

    const snapA = loadAgentCatalog(dir);
    const snapB = loadAgentCatalog(dir);

    expect(snapA.agents.map((a) => a.name)).toEqual(["keeper"]);
    expect(snapA.find("zeta")).toBeUndefined();
    expect(snapA.find("clash")).toBeUndefined();

    const conflictsA = snapA.diagnostics.filter((d) => d.code === "agent_name_conflict");
    const conflictsB = snapB.diagnostics.filter((d) => d.code === "agent_name_conflict");
    expect(conflictsA.length).toBeGreaterThan(0);
    expect(conflictsA).toEqual(conflictsB);
    for (const d of conflictsA) {
      expect(d.message).toMatch(/canonical name "clash"/i);
      expect(d.message).toMatch(/a-conflict\.md/);
      expect(d.message).toMatch(/z-conflict\.md/);
      // Deterministic path is earliest source path for the conflict group.
      expect(d.path).toMatch(/a-conflict\.md$/);
    }
  });

  it("case-insensitive lookup by canonical name only", () => {
    const dir = tempDir();
    write(
      dir,
      "e.md",
      `---
name: Explore
description: d
aliases: search
---
b
`,
    );
    const snap = loadAgentCatalog(dir);
    expect(snap.find("explore")?.name).toBe("Explore");
    expect(snap.find("EXPLORE")?.name).toBe("Explore");
    expect(snap.find("missing")).toBeUndefined();
    // Aliases no longer resolve.
    expect(snap.find("search")).toBeUndefined();
    expect(snap.agents[0]).not.toHaveProperty("aliases");
    // Migration diagnostic retained for aliases presence.
    expect(snap.diagnostics.some((d) => d.code === "agent_removed_field_aliases")).toBe(true);
  });

  it("does not scan project agents (caller only passes user dir)", () => {
    const root = tempDir();
    const user = path.join(root, "user-agents");
    const project = path.join(root, ".pi", "agents");
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    write(
      user,
      "user.md",
      `---
name: user-agent
description: user
---
u
`,
    );
    write(
      project,
      "project.md",
      `---
name: project-agent
description: project
---
p
`,
    );
    const snap = loadAgentCatalog(user);
    expect(snap.agents.map((a) => a.name)).toEqual(["user-agent"]);
  });

  it("stable sorting of agents and description", () => {
    const dir = tempDir();
    write(
      dir,
      "z.md",
      `---
name: zeta
description: Z
---
z
`,
    );
    write(
      dir,
      "a.md",
      `---
name: alpha
description: A
---
a
`,
    );
    const snap = loadAgentCatalog(dir);
    expect(snap.agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
    const desc = snap.describeForTool();
    expect(desc.indexOf("alpha")).toBeLessThan(desc.indexOf("zeta"));
  });

  it("returns empty for missing directory", () => {
    const snap = loadAgentCatalog(path.join(tempDir(), "missing"));
    expect(snap.agents).toEqual([]);
  });

  it("missing directory is non-fatal; unreadable path is fatal", () => {
    const missing = loadAgentCatalogWithStatus(path.join(tempDir(), "missing"));
    expect(missing.fatal).toBe(false);
    expect(missing.snapshot.agents).toEqual([]);

    const root = tempDir();
    const bad = path.join(root, "not-dir");
    fs.writeFileSync(bad, "file-not-dir");
    const fatal = loadAgentCatalogWithStatus(bad);
    expect(fatal.fatal).toBe(true);
    expect(fatal.snapshot.diagnostics.some((d) => d.code === "catalog_read_error")).toBe(true);
  });

  it("surface unsupported tools and removed fields in catalog diagnostics", () => {
    const dir = tempDir();
    write(
      dir,
      "mixed.md",
      `---
name: mixed
description: Mixed
tools: read, task, custom_tool
skills: librarian
---
body
`,
    );
    const snap = loadAgentCatalog(dir);
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0].tools).toEqual(["read", "task", "custom_tool"]);
    expect(snap.diagnostics.some((d) => d.code === "agent_nested_task_tool")).toBe(true);
    expect(snap.diagnostics.some((d) => d.code === "agent_unsupported_tool")).toBe(true);
    expect(snap.diagnostics.some((d) => d.code === "agent_removed_field_skills")).toBe(true);
  });
});

describe("catalog description builder", () => {
  it("includes compact core and catalog agents without nested-task duplication in description", () => {
    const desc = buildToolDescription([
      { name: "explore", description: "Fast search", body: "", filePath: "x" },
    ]);
    expect(desc).toContain("Foreground Task");
    expect(desc).toContain("explore: Fast search");
    // Nested-task policy lives in promptGuidelines, not repeated in description.
    expect(desc).not.toMatch(/Nested task/i);
  });

  it("empty catalog still builds helpful description without removed command references", () => {
    const desc = buildToolDescription([]);
    expect(desc).toMatch(/No Agent definitions|none/i);
    expect(desc).toMatch(/new session|agents\//i);
    expect(desc).not.toMatch(/task-agents|task-init/i);
    expect(formatAvailableAgents([])).toContain("none");
  });
});
