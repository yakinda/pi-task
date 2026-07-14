# pi-task

OpenCode-inspired **foreground** subagent tool for [pi](https://github.com/earendil-works/pi).

Registers one parent-callable `task` tool. Discovers specialist agents from global user markdown under `~/.pi/agent/agents/`, runs each Task as an **in-process** child `AgentSession` with a fresh conversation, and returns one XML-wrapped final answer. There are **no extension commands**.

## Requirements

- Node.js **≥ 22** (verified on Node 22 and Node 24).
- Pi coding agent **≥ 0.80.6** (verified minimum; also verified on `0.80.7`). Peer range is `"*"` for all Pi-provided runtime imports per [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md); minimum is documented and CI-matrixed, not peer-enforced.
- Pi-provided peers resolved by the host loader (do not bundle them): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox` — each declared as peerDependency `"*"`.

After install, restart pi (or start a new session). The `task` tool appears even if no agents are defined yet. Author markdown under `~/.pi/agent/agents/`.

## Install

Pi packages run with full system access. Review source before installing third-party packages.

### Local directory

```bash
pi install /absolute/path/to/pi-task
# or
pi install ./relative/path/to/pi-task
```

Local paths are recorded in settings without copying. Use `-l` to write project settings (`.pi/settings.json`) instead of user settings (`~/.pi/agent/settings.json`).

### One-off development loading (no settings write)

```bash
pi -e /absolute/path/to/pi-task
pi -e ./relative/path/to/pi-task
pi -e /absolute/path/to/pi-task/index.ts
```

### Development checkout

```bash
cd /path/to/pi-task && npm install
npm run typecheck
npm test
npm run pack:smoke
```

Or list a path under settings without `pi install`:

```json
{
  "extensions": ["/absolute/path/to/pi-task"]
}
```

## Agent markdown format

Place files in **global** `~/.pi/agent/agents/*.md` only (no project-local discovery):

```markdown
---
name: explore
description: Fast read-only codebase search specialist.
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-20250514
thinking: low
---

You are a focused codebase explorer. Prefer search tools over reading entire trees.
Return a concise structured answer with file paths.
```

### Schema

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Non-empty string. Canonical identity for `subagent_type` (case-insensitive). |
| `description` | yes | Non-empty string. Shown in the Task tool Catalog summary. |
| body | yes | Non-empty Markdown after frontmatter. Becomes the Child system role (plus a fixed final-answer contract). |
| `tools` | no | Built-in coding tools only: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Omit → request all seven. Explicit `[]` fails at preparation. |
| `model` | no | Strict `provider/modelId`. Must exist in the parent ModelRegistry with configured auth. |
| `thinking` | no | One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |

**Removed fields** (`aliases`, `tags`, `skills`): ignored with migration diagnostics. They do not reject an otherwise valid definition. Use the canonical `name` for Task lookups; Child Sessions never load Skills.

Invalid files become diagnostics and are skipped. Conflicting normalized names drop **all** conflicting definitions.

## Runtime behavior

### Catalog reload

- On extension load the Catalog is discovered once (silent — no diagnostic notify).
- On every `session_start` the Catalog reloads once from disk and emits that reload's diagnostics once (`ctx.ui.notify` or stderr).
- Fatal directory-read failures retain the previous known-good snapshot and surface failure diagnostics.

### Tools (fail-closed)

```
requested = agent.tools ?? [read, bash, edit, write, grep, find, ls]
effective = requested supported built-ins ∩ parent active tools
```

- Nested `task` is always removed with a warning.
- Custom / extension tools are never admitted.
- Parent-inactive tools are removed with a warning.
- Empty effective set fails **before** Child Session spawn.
- Missing or throwing `pi.getActiveTools` fails closed (distinct error; never treated as empty list).

### Model and thinking

1. Agent frontmatter `model` when usable (strict id, in parent registry, configured auth).
2. Exact authenticated parent model object (identity; not re-parsed).

Thinking: Agent frontmatter when valid, else parent thinking level. Unusable candidates become warnings and fall through; if none remain, Task fails.

### Trust

Child Sessions inherit the Primary project's trust snapshot (`ctx.isProjectTrusted`). Missing or throwing trust lookup → untrusted + one deterministic Warning. Trust never alters tool/model policy or throw/abort semantics.

### Hermetic Child resources

Each Child Session loads **no** ambient specialist resources:

- no extensions, Skills, project context files, prompt templates, or themes
- system prompt is exactly Agent body + fixed final-answer contract
- in-memory session only; parent ModelRegistry/auth are shared (no independent credentials)

### Concurrency

At most **four** concurrent foreground Child Sessions process-wide. Additional Tasks wait. Abort while waiting cancels without acquiring a slot. Abort while running aborts the Child and fails the Task as `AbortError`.

### Errors

Operational failures **throw** (unknown agent, empty catalog, empty tools, unusable model, empty child answer, provider error, abort). Successful results never wrap failures in completed XML.

### Bounded result

Successful Task results:

1. Sanitize XML-invalid control characters
2. Reject empty sanitized text (failure)
3. Soft-cap at **8,000 Unicode code points** (head + tail + size-aware marker)
4. Package valid XML (`state="completed"`, optional `<warnings>`, CDATA `<task_result>`)

`TaskDetails.resultText` equals the logical `<task_result>` body. Oversized output remains successful with a truncation warning. No artifacts, durable export, usage, or activity history.

### Presentation

TUI-only `renderCall` / `renderResult`: collapsed status line; expanded report shows full prompt, model/thinking/tools, warnings, elapsed time, and the same capped result as Markdown. Print/JSON/RPC use execute only — renderers are not required.

## Using the Task tool

The model calls:

```json
{
  "description": "find auth entrypoints",
  "prompt": "Locate authentication entrypoints and summarize call sites with file paths.",
  "subagent_type": "explore"
}
```

- `description` — short 3–5 word summary (≤120 characters)
- `prompt` — full delegated instructions (only user message content)
- `subagent_type` — canonical Agent name (case-insensitive)

## Manual Agent example

`~/.pi/agent/agents/explore.md`:

```markdown
---
name: explore
description: Fast read-only codebase search.
tools: read, grep, find, ls
---

You search the repository efficiently.
Return a concise answer with file paths. Do not modify files.
```

Then start a new pi session and ask the Primary agent to use Task with `subagent_type: explore`.

## Package API (tests / advanced)

```ts
import { createTaskExtension } from "pi-task";

export default createTaskExtension({
  // agentsDir?: string        — override Catalog directory (tests)
  // sessionFactory?: SessionFactory — inject Child Session creation (tests)
});
```

Default export is `createTaskExtension()` for Pi package auto-discovery.

## Verify

```bash
npm run typecheck
npm test
npm run pack:smoke   # real tarball → extract → local Pi package path install
```

CI runs typecheck, tests, and package smoke on Node 22/24 against Pi `0.80.6` and `0.80.7`.

## Layout

```
index.ts                 # createTaskExtension + default export
src/
  catalog.ts             # Agent discovery, schema, immutable Catalog reload
  task.ts                # TaskExecutor lifecycle
  task-preparation.ts    # model/tools/thinking resolution
  task-contract.ts       # provider-facing Task metadata
  child-session.ts       # hermetic Child Session runner
  capabilities.ts        # tool intersection
  model.ts               # model cascade helpers
  result.ts              # sanitize, soft-cap, XML packaging
  semaphore.ts           # max-4 concurrency gate
  task-renderer.ts       # TUI presentation
  task-report.ts         # phase/elapsed helpers
README.md
LICENSE
```
