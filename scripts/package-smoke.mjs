#!/usr/bin/env node
/**
 * Package artifact smoke (no live provider; no network beyond prior dependency install).
 *
 * Builds a real tarball with `npm pack`, extracts it, then installs the extracted
 * directory as a clean local Pi package path via DefaultPackageManager (not a
 * registry/npm tarball source). Asserts the single Task tool registration
 * (and no extension commands) through DefaultResourceLoader / createAgentSession.
 *
 * Steps:
 * 1. Inspect `npm pack --dry-run --json` allowlist contents
 * 2. Build a real tarball with `npm pack`
 * 3. Extract it into a clean temp directory
 * 4. Install that extracted directory through Pi's local package path flow
 * 5. Load the package via DefaultResourceLoader / createAgentSession
 * 6. Assert exactly one extension-owned tool (`task`) and zero extension commands
 *
 * Usage: node scripts/package-smoke.mjs
 * Exit 0 on success; non-zero with diagnostics on failure.
 *
 * Generated tarballs and temp directories are always cleaned up.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

/** Critical runtime entry + core modules that must ship. */
export const REQUIRED_PATHS = [
  "package.json",
  "index.ts",
  "LICENSE",
  "README.md",
  "src/task.ts",
  "src/task-renderer.ts",
  "src/catalog.ts",
  "src/child-session.ts",
  "src/result.ts",
  "src/task-contract.ts",
  "src/task-preparation.ts",
  "src/task-report.ts",
  "src/capabilities.ts",
  "src/model.ts",
  "src/semaphore.ts",
];

/** Path prefixes that must never appear in the runtime tarball. */
export const FORBIDDEN_PREFIXES = [
  "test/",
  "scripts/",
  ".github/",
  "starters/",
  "issues/",
  "docs/",
];

/** Exact planning/dev files that must never appear in the runtime tarball. */
export const FORBIDDEN_EXACT = new Set([
  "PRD.md",
  "PRD_USABILITY_EFFICIENCY.md",
  "PRD_ROADMAP.md",
  "PRD_CORE_SIMPLIFICATION.md",
  "ISSUES.md",
  "ISSUES_USABILITY_EFFICIENCY.md",
  "ISSUES_ROADMAP.md",
  "IMPLEMENTATION_PLAN.md",
  "CONTEXT.md",
  "CHANGELOG.md",
  "docs/RELEASE_SMOKE.md",
  "vitest.config.ts",
  "tsconfig.json",
  "package-lock.json",
]);

/** Pi-provided runtime imports must use peerDependency "*" (packages.md). */
const PI_PEER_STAR = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

function fail(message) {
  throw new Error(`package-smoke FAIL: ${message}`);
}

function listPackFiles() {
  const raw = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry?.files ?? []).map((f) =>
    typeof f === "string" ? f : f.path ?? f.name,
  );
  if (!files.length) fail("npm pack --dry-run --json returned no files");
  return { files, entry };
}

function assertAllowlist(files) {
  for (const required of REQUIRED_PATHS) {
    if (!files.includes(required)) {
      fail(`tarball missing required runtime path: ${required}`);
    }
  }
  for (const file of files) {
    if (FORBIDDEN_EXACT.has(file)) {
      fail(`tarball includes forbidden planning/dev file: ${file}`);
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (file === prefix.slice(0, -1) || file.startsWith(prefix)) {
        fail(`tarball includes forbidden path prefix ${prefix}: ${file}`);
      }
    }
    if (file.endsWith(".test.ts")) {
      fail(`tarball includes test file: ${file}`);
    }
    // Only intended categories: package.json (always), entry, runtime src, README, LICENSE.
    if (
      file !== "package.json" &&
      file !== "index.ts" &&
      file !== "README.md" &&
      file !== "LICENSE" &&
      !file.startsWith("src/")
    ) {
      fail(`tarball includes unexpected path outside allowlist categories: ${file}`);
    }
  }
}

function buildTarball() {
  const out = execFileSync("npm", ["pack", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
  const lines = out.split(/\r?\n/).filter(Boolean);
  const filename = lines[lines.length - 1];
  if (!filename?.endsWith(".tgz")) {
    fail(`unexpected npm pack output: ${out}`);
  }
  const tarballPath = path.join(packageRoot, filename);
  if (!fs.existsSync(tarballPath)) {
    fail(`packed tarball not found: ${tarballPath}`);
  }
  return tarballPath;
}

function extractTarball(tarballPath, destRoot) {
  fs.mkdirSync(destRoot, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", destRoot], {
    encoding: "utf8",
  });
  const packageDir = path.join(destRoot, "package");
  if (!fs.existsSync(path.join(packageDir, "package.json"))) {
    fail(`extracted package.json missing under ${packageDir}`);
  }

  const pkg = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  const peers = pkg.peerDependencies ?? {};
  for (const name of PI_PEER_STAR) {
    if (!peers[name]) fail(`extracted package missing peerDependency ${name}`);
    if (peers[name] !== "*") {
      fail(
        `peerDependency ${name} must be "*" per Pi packages.md (got ${JSON.stringify(peers[name])})`,
      );
    }
  }

  // Simplified runtime has no dedicated production dependencies (yaml removed).
  const runtimeDeps = pkg.dependencies ?? {};
  if (Object.keys(runtimeDeps).length > 0) {
    fail(
      `extracted package must not declare runtime dependencies (got ${JSON.stringify(runtimeDeps)})`,
    );
  }
  if (runtimeDeps.yaml) {
    fail('extracted package must not declare runtime dependency "yaml"');
  }

  if (pkg.version !== "0.3.0") {
    fail(`extracted package version is ${pkg.version}, expected 0.3.0`);
  }
  if (!pkg.engines?.node || !/(^|\s)(>=|>)\s*22(\b|\.0)/.test(pkg.engines.node)) {
    fail(`extracted package engines.node must declare Node 22+ (got ${JSON.stringify(pkg.engines)})`);
  }

  let rootExport;
  if (typeof pkg.exports === "string") {
    rootExport = pkg.exports;
  } else if (pkg.exports && typeof pkg.exports["."] === "string") {
    rootExport = pkg.exports["."];
  } else if (
    pkg.exports &&
    pkg.exports["."] &&
    typeof pkg.exports["."] === "object" &&
    typeof pkg.exports["."].import === "string"
  ) {
    rootExport = pkg.exports["."].import;
  } else {
    rootExport = pkg.main;
  }
  const piEntry = pkg.pi?.extensions?.[0];
  const norm = (s) => String(s).replace(/^\.\//, "");
  if (!rootExport || !piEntry || norm(rootExport) !== norm(piEntry)) {
    fail(
      `root export must resolve to Pi extension entry (exports=${JSON.stringify(pkg.exports)}, pi=${JSON.stringify(pkg.pi)})`,
    );
  }
  if (pkg.repository !== undefined || pkg.homepage !== undefined || pkg.bugs !== undefined) {
    fail("local-only package must not declare repository, homepage, or bugs URLs");
  }
  if (!pkg.files || !Array.isArray(pkg.files)) {
    fail("extracted package missing files allowlist");
  }
  const expectedFiles = ["index.ts", "src/**/*.ts", "README.md", "LICENSE"];
  const filesSorted = [...pkg.files].map(String).sort();
  const expectedSorted = [...expectedFiles].sort();
  if (JSON.stringify(filesSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `files allowlist must be exactly ${JSON.stringify(expectedFiles)} (got ${JSON.stringify(pkg.files)})`,
    );
  }
  if (pkg.files.includes("CHANGELOG.md") || pkg.files.includes("CONTEXT.md")) {
    fail("files allowlist must not include CHANGELOG.md or CONTEXT.md");
  }
  if (pkg.files.some((f) => String(f).includes("starters"))) {
    fail("files allowlist must not include starters");
  }
  if (pkg.license !== "MIT") fail(`license metadata is ${pkg.license}, expected MIT`);
  if (!fs.existsSync(path.join(packageDir, "LICENSE"))) {
    fail("extracted package missing LICENSE file");
  }
  if (fs.existsSync(path.join(packageDir, "CHANGELOG.md"))) {
    fail("extracted package must not include CHANGELOG.md");
  }
  if (fs.existsSync(path.join(packageDir, "CONTEXT.md"))) {
    fail("extracted package must not include CONTEXT.md");
  }
  if (fs.existsSync(path.join(packageDir, "starters"))) {
    fail("extracted package must not include starters/");
  }
  if (fs.existsSync(path.join(packageDir, "src", "settings.ts"))) {
    fail("extracted package must not include deleted settings.ts");
  }
  if (fs.existsSync(path.join(packageDir, "src", "catalog-operations.ts"))) {
    fail("extracted package must not include deleted catalog-operations.ts");
  }
  return packageDir;
}

async function installAndSmoke(packageDir) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-cwd-"));
  const cleanup = () => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  };

  try {
    // Clean Pi agent/config location: empty settings, then install local package path.
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager,
    });

    // Standard local package install: extracted directory path is validated and
    // persisted to settings. Prefer absolute path so settings store a
    // stable source (relative paths resolve against agentDir).
    const absolutePackageDir = path.resolve(packageDir);
    await packageManager.installAndPersist(absolutePackageDir);

    const configured = packageManager.listConfiguredPackages();
    const expected = path.resolve(absolutePackageDir);
    const matches = configured.some((p) => {
      const src = p.source;
      if (path.isAbsolute(src)) return path.resolve(src) === expected;
      return path.resolve(agentDir, src) === expected || path.resolve(cwd, src) === expected;
    });
    if (!matches) {
      fail(
        `package not listed in settings after install: ${JSON.stringify(configured)} (expected ${expected})`,
      );
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const extensionsResult = resourceLoader.getExtensions();
    if (extensionsResult.errors?.length) {
      fail(
        `extension load errors: ${extensionsResult.errors
          .map((e) => e.message ?? String(e))
          .join("; ")}`,
      );
    }
    if (!extensionsResult.extensions?.length) {
      fail("no extensions loaded from installed package");
    }

    const auth = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.create(auth);
    const { session, extensionsResult: sessionExt } = await createAgentSession({
      cwd,
      agentDir,
      authStorage: auth,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      // Include task so an allowlist does not hide the registered extension tool.
      tools: ["read", "task"],
    });

    try {
      const extList =
        sessionExt?.extensions ?? extensionsResult.extensions ?? [];
      if (!extList.length) fail("session has no loaded extensions");

      const toolNames = new Set();
      const commandNames = new Set();
      for (const ext of extList) {
        const tools = ext.tools;
        if (tools instanceof Map) {
          for (const name of tools.keys()) toolNames.add(name);
        }
        const cmds = ext.commands;
        if (cmds instanceof Map) {
          for (const name of cmds.keys()) commandNames.add(name);
        } else if (Array.isArray(cmds)) {
          for (const c of cmds) {
            commandNames.add(typeof c === "string" ? c : c.name);
          }
        }
      }

      if (!toolNames.has("task")) {
        const def =
          typeof session.getToolDefinition === "function"
            ? session.getToolDefinition("task")
            : undefined;
        const all = session.getAllTools?.() ?? [];
        if (!def && !all.some((t) => t.name === "task")) {
          fail(
            `task tool not registered; extension tools=${[...toolNames].join(",")} session=${all.map((t) => t.name).join(",")}`,
          );
        }
        toolNames.add("task");
      }

      // Exactly one extension-owned tool: task.
      const extensionTools = [...toolNames].sort();
      if (extensionTools.length !== 1 || extensionTools[0] !== "task") {
        fail(
          `extension must register exactly one tool "task"; tools=${extensionTools.join(",")}`,
        );
      }

      // Public surface is the single task tool only — no extension commands.
      if (commandNames.size > 0) {
        fail(
          `extension must register no commands; commands=${[...commandNames].sort().join(",")}`,
        );
      }
      for (const legacy of ["task-agents", "task-init", "task-result"]) {
        if (commandNames.has(legacy)) {
          fail(`legacy command still registered: ${legacy}`);
        }
      }

      const loaded = extensionsResult.extensions[0];
      const extPath = loaded?.resolvedPath ?? loaded?.path;
      if (!extPath) fail("loaded extension has no path");
      const packageBase = path.dirname(extPath);

      // Starters / context / changelog must not ship beside the extension.
      if (fs.existsSync(path.join(packageBase, "starters"))) {
        fail("runtime package must not include starters/");
      }
      if (fs.existsSync(path.join(packageBase, "CHANGELOG.md"))) {
        fail("runtime package must not include CHANGELOG.md");
      }
      if (fs.existsSync(path.join(packageBase, "CONTEXT.md"))) {
        fail("runtime package must not include CONTEXT.md");
      }
      if (fs.existsSync(path.join(packageBase, "docs", "adr"))) {
        fail("runtime package must not include docs/adr");
      }
      if (!fs.existsSync(path.join(packageBase, "README.md"))) {
        fail("README.md missing beside extension");
      }
      if (!fs.existsSync(path.join(packageBase, "LICENSE"))) {
        fail("LICENSE missing beside extension");
      }

      const active = (session.getAllTools?.() ?? []).map((t) => t.name);
      console.log("package-smoke OK");
      console.log(
        "  real tarball built/extracted; installed as local Pi package path (not registry tarball)",
      );
      console.log(`  packageDir: ${packageDir}`);
      console.log(`  agentDir:   ${agentDir}`);
      console.log(`  registered tools:    ${[...toolNames].sort().join(", ")}`);
      console.log(`  active tools:       ${active.join(", ")}`);
      console.log(`  commands:           ${[...commandNames].sort().join(", ")}`);
    } finally {
      session.dispose?.();
    }
  } finally {
    cleanup();
  }
}

async function main() {
  console.log("package-smoke: inspecting dry-run pack list…");
  const { files, entry } = listPackFiles();
  console.log(
    `  dry-run files: ${files.length}, unpacked≈${entry?.unpackedSize ?? "?"} bytes`,
  );
  assertAllowlist(files);

  console.log("package-smoke: building real tarball…");
  const tarballPath = buildTarball();
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-pack-"));
  let packageDir;
  try {
    packageDir = extractTarball(tarballPath, extractRoot);
    console.log(`  extracted: ${packageDir}`);
    console.log(
      "package-smoke: installing extracted dir as local Pi package path + loading…",
    );
    await installAndSmoke(packageDir);
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.rmSync(tarballPath, { force: true });
  }
}

// Only auto-run when executed directly (not when imported by tests).
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
