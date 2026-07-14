/**
 * No-provider integration: create a real Pi AgentSession and prove hermetic isolation.
 * Child loads no extensions, Skills, context files, prompt templates, themes, or
 * appended system-prompt resources. System prompt is exactly Agent body + contract.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildSpecialistSystemPrompt,
  createChildResourceLoader,
  forceSpecialistSystemPrompt,
  FINAL_ANSWER_WRAPPER,
} from "../src/child-session.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-res-"));
  tempDirs.push(dir);
  return dir;
}

async function createInspectableSession(opts: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  agentBody: string;
  tools?: string[];
}) {
  const settingsManager = SettingsManager.create(opts.cwd, opts.agentDir, {
    projectTrusted: opts.projectTrusted,
  });
  const specialistPrompt = buildSpecialistSystemPrompt(opts.agentBody);
  const resourceLoader = createChildResourceLoader(
    {
      cwd: opts.cwd,
      agentDir: opts.agentDir,
      agentBody: opts.agentBody,
    },
    settingsManager,
  );
  await resourceLoader.reload();

  const auth = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(auth);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    authStorage: auth,
    modelRegistry,
    tools: opts.tools ?? ["read"],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(opts.cwd),
  });

  // Match production SessionFactory: pin exact specialist role after construction.
  forceSpecialistSystemPrompt(session, specialistPrompt);

  return { session, resourceLoader, specialistPrompt };
}

describe("child resources integration (hermetic, no provider)", () => {
  it("system prompt is exactly Agent body + final-answer contract (no AGENTS/date/cwd)", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const marker = "UNIQUE_AGENTS_MARKER_42";
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), `${marker}\nFollow project rules.`);
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "CLAUDE_SHOULD_NOT_APPEAR");

    const body = "UNIQUE_AGENT_BODY_99";
    const { session, specialistPrompt } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: body,
    });

    try {
      const prompt = session.systemPrompt;
      expect(prompt).toBe(specialistPrompt);
      expect(prompt).toBe(`${body}\n\n${FINAL_ANSWER_WRAPPER.trim()}`);
      expect(countOccurrences(prompt, body)).toBe(1);
      expect(countOccurrences(prompt, "Task result contract")).toBe(1);
      expect(prompt).not.toContain(marker);
      expect(prompt).not.toContain("CLAUDE_SHOULD_NOT_APPEAR");
      expect(prompt).not.toMatch(/Current date:/);
      expect(prompt).not.toMatch(/Current working directory:/);
      expect(prompt).not.toMatch(/project_context|project_instructions/i);
    } finally {
      session.dispose();
    }
  });

  it("APPEND_SYSTEM is not appended when override returns []", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    fs.mkdirSync(path.join(agentDir), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "SHOULD_NOT_APPEAR_APPEND");

    const { session, specialistPrompt } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      expect(session.systemPrompt).toBe(specialistPrompt);
      expect(session.systemPrompt).not.toContain("SHOULD_NOT_APPEAR_APPEND");
    } finally {
      session.dispose();
    }
  });

  it("extensions are not loaded (noExtensions)", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const extDir = path.join(agentDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, "evil.ts"),
      `export default () => {}; // SHOULD_NOT_LOAD_EXT`,
    );

    const { session, resourceLoader } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      const extensions = resourceLoader.getExtensions();
      expect(extensions.extensions?.length ?? 0).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("Skills are fully disabled (noSkills)", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    for (const name of ["architecture", "librarian"]) {
      const dir = path.join(agentDir, "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} Skill\n---\nInstructions.\n`,
      );
    }

    const { session, resourceLoader, specialistPrompt } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      expect(resourceLoader.getSkills().skills).toEqual([]);
      expect(session.systemPrompt).toBe(specialistPrompt);
      expect(session.systemPrompt).not.toMatch(/architecture|librarian|skill/i);
    } finally {
      session.dispose();
    }
  });

  it("context files are disabled (noContextFiles / agentsFiles empty)", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT_AGENTS_SHOULD_NOT_LOAD");

    const { session, resourceLoader } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(session.systemPrompt).not.toContain("PROJECT_AGENTS_SHOULD_NOT_LOAD");
    } finally {
      session.dispose();
    }
  });

  it("prompt templates and themes are disabled", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const promptsDir = path.join(agentDir, "prompts");
    const themesDir = path.join(agentDir, "themes");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "hello.md"), "TEMPLATE_SHOULD_NOT_LOAD");
    fs.writeFileSync(path.join(themesDir, "dark.json"), "{}");

    const { session, resourceLoader } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      expect(resourceLoader.getPrompts().prompts).toEqual([]);
      expect(resourceLoader.getThemes().themes).toEqual([]);
      expect(session.systemPrompt).not.toContain("TEMPLATE_SHOULD_NOT_LOAD");
    } finally {
      session.dispose();
    }
  });

  it("untrusted project does not load project-local settings trust", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const { session } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: false,
      agentBody: "Body",
    });

    try {
      expect(session.settingsManager.isProjectTrusted()).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it("resource loader reports empty append system prompt", async () => {
    const cwd = tempDir();
    const agentDir = tempDir();
    const { session, resourceLoader } = await createInspectableSession({
      cwd,
      agentDir,
      projectTrusted: true,
      agentBody: "Body",
    });

    try {
      expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(resourceLoader.getSystemPrompt()).toBe(buildSpecialistSystemPrompt("Body"));
    } finally {
      session.dispose();
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}
