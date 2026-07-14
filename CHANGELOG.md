# Changelog

All notable local release milestones for `pi-task` are documented here.

## Unreleased

### Breaking — core simplification

- Public surface is one foreground `task` tool only. Extension commands (`/task-agents`, `/task-init`, `/task-result`) and all Catalog management, wizard, doctor, autocomplete, and starter-setup flows are removed.
- Agent schema is reduced to required non-empty `name`, `description`, and Markdown body; optional `tools`, `model`, and `thinking` only. `aliases`, `tags`, and `skills` are ignored with migration diagnostics.
- Catalog is global-only (`~/.pi/agent/agents/*.md`) and reloads on `session_start`. `settings.subagents` (default model, agent overrides, `trustAgentTools`) is no longer read.
- Model cascade is Agent frontmatter then the exact authenticated parent model. Child tools always intersect parent active tools (fail-closed when the active-tool API is missing).
- Child Sessions are fully hermetic (no extensions, Skills, context files, prompt templates, themes, or appended system-prompt resources).
- Successful results are one sanitized, 8,000-code-point soft-capped XML envelope; `TaskDetails.resultText` equals the logical `<task_result>` body. Artifacts, durable export, usage/telemetry, heartbeat, and activity history are removed.
- Package ships only `index.ts`, `src/**/*.ts`, `README.md`, and `LICENSE`. Bundled `starters/`, `CONTEXT.md`, live-smoke, and the `yaml` runtime dependency are removed. Version remains `0.3.0`.
- Factory options are only `agentsDir` and `sessionFactory`.

## 0.3.0 — Scale

- Agent aliases and tags for Catalog organization without changing canonical identity.
- Deterministic Catalog search with stable ranking and canonical-name tie-break.
- Explicit durable result export separate from temporary Result artifacts.
- Async Result artifact finalization with a fixed 10 MiB UTF-8 artifact budget.
- Local package identity set to the complete roadmap version `0.3.0`.

## 0.2.0 — Usability

- TUI wizard to create and edit user Agent definitions through Catalog commands.
- Dynamic autocomplete for Catalog command actions and canonical Agent names.
- Structured Catalog doctor JSON (`schemaVersion: 1`) for automation-friendly preflight.

## 0.1.0 — Hardening

- Fail-closed Parent project-trust snapshot for Child Sessions.
- Deterministic Warning when trust lookup is missing or throws.
- Local package metadata: Node `>=22`, explicit root export, no public repository URLs.
- CI matrix for Node 22/24 against Pi `0.80.6` and `0.80.7` with real package smoke.
- Zero-cost live-smoke helper for physical TUI/provider checks (no automated provider calls).
