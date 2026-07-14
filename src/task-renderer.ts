/**
 * Task-specific call/result rendering (collapsed + expanded run reports).
 *
 * Presentation only — never participates in Primary-agent model context.
 * Safe to import from non-TUI paths; Pi only invokes renderCall/renderResult in TUI.
 * Functions degrade when theme helpers or optional detail fields are missing.
 *
 * Expanded view uses retained TaskDetails after resume (full prompt, config,
 * warnings, elapsed time, and the same capped resultText as the model channel
 * as Markdown).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import type { TaskCurrentTool, TaskDetails, TaskPhase } from "./task.ts";

/** Tool-call args for the Task tool (schema field names). */
export interface TaskCallArgs {
  description?: string;
  prompt?: string;
  subagent_type?: string;
}

/** Minimal result shape used by the renderer (loose for optional/partial details). */
export interface TaskRenderResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface TaskRenderResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** Bound for collapsed delegated-prompt preview (never the full prompt). */
export const PROMPT_PREVIEW_MAX = 60;

/**
 * Collapsed call view: Agent definition name, description, bounded prompt preview.
 * Never shows the full delegated prompt.
 */
export function renderTaskCall(args: TaskCallArgs, theme: ThemeLike): Text {
  const agent = nonEmpty(args.subagent_type) ?? "…";
  const description = nonEmpty(args.description) ?? "…";
  const preview = boundPreview(args.prompt ?? "", PROMPT_PREVIEW_MAX);

  let text =
    theme.fg("toolTitle", theme.bold("task ")) +
    theme.fg("accent", agent) +
    theme.fg("muted", ` — ${description}`);

  if (preview) {
    text += `\n  ${theme.fg("dim", preview)}`;
  }

  return new Text(text, 0, 0);
}

/**
 * Result view for partial (queued/running) and terminal (completed/failed/aborted) Tasks.
 * Collapsed form stays compact; expanded form is the full run report.
 * Expansion hint uses configured `app.tools.expand`.
 */
export function renderTaskResult(
  result: TaskRenderResult,
  options: TaskRenderResultOptions,
  theme: ThemeLike,
  context?: { isError?: boolean; args?: TaskCallArgs },
): Component {
  const details = asTaskDetails(result.details);
  const isError = Boolean(result.isError || context?.isError);

  // No structured details — fall back to Pi content / error text safely.
  if (!details) {
    return renderFallback(result, theme, isError, options.expanded);
  }

  const phase = details.phase;
  const { expanded, isPartial } = options;

  // Partial / in-flight: queued | running
  if (isPartial || isInFlightPhase(phase)) {
    return renderPartial(details, theme, expanded, context?.args);
  }

  // Terminal outcomes
  if (phase === "aborted") {
    return renderTerminal(details, theme, {
      icon: theme.fg("warning", "⊘"),
      label: "aborted",
      labelColor: "warning",
      expanded,
      args: context?.args,
    });
  }

  if (phase === "failed" || isError) {
    return renderTerminal(details, theme, {
      icon: theme.fg("error", "✗"),
      label: "failed",
      labelColor: "error",
      expanded,
      args: context?.args,
    });
  }

  // completed (default terminal success)
  return renderTerminal(details, theme, {
    icon: theme.fg("success", "✓"),
    label: "completed",
    labelColor: "success",
    expanded,
    args: context?.args,
  });
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Theme surface used by the renderer (real Theme or test double). */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
}

function asTaskDetails(raw: unknown): Partial<TaskDetails> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as Partial<TaskDetails>;
}

function isInFlightPhase(phase: TaskPhase | string | undefined): boolean {
  return phase === "queued" || phase === "running";
}

/**
 * Collapsed partial: lifecycle, Agent, description, elapsed (when present).
 * Running may show current tool name/status only — never args or output.
 */
function renderPartial(
  details: Partial<TaskDetails>,
  theme: ThemeLike,
  expanded: boolean,
  args?: TaskCallArgs,
): Component {
  if (expanded) {
    return renderExpandedReport(details, theme, {
      icon: theme.fg(colorForPhase(details.phase ?? "running"), phaseIcon(details.phase ?? "running")),
      label: labelForPhase(details.phase ?? "running"),
      labelColor: colorForPhase(details.phase ?? "running"),
      args,
      isPartial: true,
    });
  }

  const phase = details.phase ?? "running";
  const agent = nonEmpty(details.agent) ?? nonEmpty(details.subagentType) ?? "…";
  const description = nonEmpty(details.description) ?? "";
  const phaseLabel = labelForPhase(phase);
  const phaseColor = colorForPhase(phase);

  let text =
    theme.fg(phaseColor, phaseIcon(phase)) +
    " " +
    theme.fg("toolTitle", theme.bold("task ")) +
    theme.fg("accent", agent);

  if (description) {
    text += theme.fg("muted", ` — ${description}`);
  }

  text += theme.fg(phaseColor, ` [${phaseLabel}]`);

  // Elapsed when available (non-negative).
  const elapsed = formatElapsedPart(details.elapsedMs, theme);
  if (elapsed) {
    text += theme.fg("dim", ` ${elapsed}`);
  }

  // Current tool only (name + status; no identity/args/output).
  const currentTool = details.currentTool;
  if (currentTool && phase === "running") {
    text += "\n" + formatCurrentToolLine(currentTool, theme);
  } else if (phase === "running") {
    text += `\n  ${theme.fg("dim", "… working")}`;
  }

  text += expansionHintLine(theme);

  return new Text(text, 0, 0);
}

/**
 * Collapsed terminal: lifecycle, Agent, description, elapsed, warning count.
 */
function renderTerminal(
  details: Partial<TaskDetails>,
  theme: ThemeLike,
  opts: {
    icon: string;
    label: string;
    labelColor: string;
    expanded: boolean;
    args?: TaskCallArgs;
  },
): Component {
  if (opts.expanded) {
    return renderExpandedReport(details, theme, {
      icon: opts.icon,
      label: opts.label,
      labelColor: opts.labelColor,
      args: opts.args,
      isPartial: false,
    });
  }

  const agent = nonEmpty(details.agent) ?? nonEmpty(details.subagentType) ?? "…";
  const description = nonEmpty(details.description) ?? "";

  let text =
    opts.icon +
    " " +
    theme.fg("toolTitle", theme.bold("task ")) +
    theme.fg("accent", agent);

  if (description) {
    text += theme.fg("muted", ` — ${description}`);
  }

  text += theme.fg(opts.labelColor, ` [${opts.label}]`);

  // Compact summary line: elapsed, optional warning count
  const summary = formatCompletedSummary(details, theme);
  if (summary) {
    text += `\n  ${summary}`;
  }

  text += expansionHintLine(theme);

  return new Text(text, 0, 0);
}

/**
 * Expanded Task run report.
 * Full delegated prompt, effective configuration, warnings, elapsed time, and
 * the same capped resultText as the model channel as Markdown.
 * Tolerates missing optional model / thinking / result without legacy branches.
 */
function renderExpandedReport(
  details: Partial<TaskDetails>,
  theme: ThemeLike,
  opts: {
    icon: string;
    label: string;
    labelColor: string;
    args?: TaskCallArgs;
    isPartial: boolean;
  },
): Component {
  const container = new Container();
  const agent = nonEmpty(details.agent) ?? nonEmpty(details.subagentType) ?? "…";
  const description = nonEmpty(details.description) ?? "";

  let header =
    opts.icon +
    " " +
    theme.fg("toolTitle", theme.bold("task ")) +
    theme.fg("accent", agent);
  if (description) {
    header += theme.fg("muted", ` — ${description}`);
  }
  header += theme.fg(opts.labelColor, ` [${opts.label}]`);
  container.addChild(new Text(header, 0, 0));

  // ── Prompt (full; human-only) ─────────────────────────────────────────────
  const prompt = resolvePrompt(details, opts.args);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
  if (prompt) {
    // Preserve multi-line delegated prompt verbatim (not boundPreview).
    container.addChild(new Text(theme.fg("dim", prompt), 0, 0));
  } else {
    container.addChild(new Text(theme.fg("muted", "(no prompt)"), 0, 0));
  }

  // ── Effective configuration ───────────────────────────────────────────────
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Configuration ───"), 0, 0));
  container.addChild(new Text(formatConfigLines(details, theme), 0, 0));

  // ── Elapsed ───────────────────────────────────────────────────────────────
  const elapsedLine = formatElapsedLine(details.elapsedMs, theme);
  if (elapsedLine) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Timing ───"), 0, 0));
    container.addChild(new Text(elapsedLine, 0, 0));
  }

  // Current tool (partial only; terminal details omit this)
  if (details.currentTool) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Current tool ───"), 0, 0));
    container.addChild(new Text(formatCurrentToolLine(details.currentTool, theme), 0, 0));
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  if (warnings.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("warning", `─── Warnings (${warnings.length}) ───`), 0, 0),
    );
    for (const w of warnings) {
      container.addChild(new Text(`  ${theme.fg("dim", String(w))}`, 0, 0));
    }
  }

  // ── Capped result (same text as model channel) ────────────────────────────
  // Only when resultText is present (terminal success / resume).
  const humanResult = resolveHumanResult(details);
  if (humanResult !== undefined) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
    if (humanResult.trim().length === 0) {
      container.addChild(new Text(theme.fg("muted", "(empty)"), 0, 0));
    } else {
      container.addChild(new Markdown(humanResult.trim(), 0, 0, resolveMarkdownTheme()));
    }
  }

  return container;
}

function resolvePrompt(
  details: Partial<TaskDetails>,
  args?: TaskCallArgs,
): string | undefined {
  // Prefer retained details (resume-safe); fall back to live call args.
  const fromDetails = nonEmpty(details.prompt);
  if (fromDetails) return details.prompt;
  const fromArgs = nonEmpty(args?.prompt);
  if (fromArgs) return args?.prompt;
  return undefined;
}

function resolveHumanResult(details: Partial<TaskDetails>): string | undefined {
  if (typeof details.resultText === "string") return details.resultText;
  return undefined;
}

/**
 * Effective model / thinking / tools. Tolerates missing optional fields
 * without modelSource or other deleted telemetry.
 */
function formatConfigLines(details: Partial<TaskDetails>, theme: ThemeLike): string {
  const lines: string[] = [];
  const model = nonEmpty(details.model) ?? "—";
  lines.push(`  ${theme.fg("muted", "model:")} ${theme.fg("dim", model)}`);
  const thinking = nonEmpty(details.thinking as string | undefined) ?? "—";
  lines.push(`  ${theme.fg("muted", "thinking:")} ${theme.fg("dim", thinking)}`);
  const tools = Array.isArray(details.tools) ? details.tools : [];
  const toolsStr = tools.length > 0 ? tools.join(", ") : "(none)";
  lines.push(`  ${theme.fg("muted", "tools:")} ${theme.fg("dim", toolsStr)}`);
  return lines.join("\n");
}

function formatElapsedLine(
  elapsedMs: number | undefined,
  theme: ThemeLike,
): string | undefined {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return undefined;
  const ms = Math.max(0, elapsedMs);
  return `  ${theme.fg("muted", "elapsed:")} ${theme.fg("dim", formatDuration(ms))}`;
}

function formatElapsedPart(
  elapsedMs: number | undefined,
  theme: ThemeLike,
): string | undefined {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return undefined;
  return formatDuration(Math.max(0, elapsedMs));
}

function formatCurrentToolLine(tool: TaskCurrentTool, theme: ThemeLike): string {
  const mark =
    tool.status === "running"
      ? theme.fg("warning", "→")
      : tool.status === "error"
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
  // Name + status mark only — never toolCallId, args, or output.
  const name = theme.fg("muted", tool.toolName ?? "tool");
  return `  ${mark} ${name}`;
}

function formatCompletedSummary(
  details: Partial<TaskDetails>,
  theme: ThemeLike,
): string {
  const parts: string[] = [];

  const elapsed = details.elapsedMs;
  if (typeof elapsed === "number" && Number.isFinite(elapsed)) {
    parts.push(theme.fg("dim", formatDuration(Math.max(0, elapsed))));
  }

  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  if (warnings.length > 0) {
    parts.push(
      theme.fg(
        "warning",
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
      ),
    );
  }

  return parts.join(theme.fg("dim", " · "));
}

function renderFallback(
  result: TaskRenderResult,
  theme: ThemeLike,
  isError: boolean,
  expanded: boolean,
): Text {
  const textPart = result.content?.find((c) => c.type === "text");
  const raw =
    typeof textPart?.text === "string" && textPart.text.length > 0
      ? textPart.text
      : isError
        ? "Task failed"
        : "(no output)";
  // Expanded fallback may show full error text; collapsed stays first line.
  const body = expanded ? raw : (raw.split("\n")[0] ?? raw);
  const color = isError ? "error" : "muted";
  return new Text(theme.fg(color, body), 0, 0);
}

/**
 * Expansion hint derived from configured `app.tools.expand` keybinding.
 * Degrades safely when keyHint/keybindings are unavailable (non-TUI tests).
 */
function expansionHintLine(theme: ThemeLike): string {
  try {
    const hint = keyHint("app.tools.expand", "to expand");
    if (hint && hint.trim().length > 0) {
      return `\n  ${theme.fg("muted", "(")}${hint}${theme.fg("muted", ")")}`;
    }
  } catch {
    // keyHint may throw if theme/keybindings are not initialised
  }
  // Safe plain-text fallback still naming the keybinding id (not a hard-coded chord alone).
  return `\n  ${theme.fg("dim", "(app.tools.expand to expand)")}`;
}

/**
 * Resolve Pi Markdown theme. Falls back to an identity theme when
 * getMarkdownTheme is unavailable or Theme is not initialised (tests / print).
 * Real TUI always has initTheme(); probing bold() catches the half-init case.
 */
function resolveMarkdownTheme(): MarkdownTheme {
  try {
    const md = getMarkdownTheme();
    // getMarkdownTheme may return wrappers that only throw when applied.
    void md.bold("probe");
    return md;
  } catch {
    return identityMarkdownTheme();
  }
}

function identityMarkdownTheme(): MarkdownTheme {
  const id = (t: string) => t;
  return {
    heading: id,
    link: id,
    linkUrl: id,
    code: id,
    codeBlock: id,
    codeBlockBorder: id,
    quote: id,
    quoteBorder: id,
    hr: id,
    listBullet: id,
    bold: id,
    italic: id,
    strikethrough: id,
    underline: id,
  };
}

function labelForPhase(phase: TaskPhase | string): string {
  switch (phase) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return String(phase);
  }
}

function colorForPhase(phase: TaskPhase | string): string {
  switch (phase) {
    case "queued":
      return "warning";
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "warning";
    default:
      return "muted";
  }
}

function phaseIcon(phase: TaskPhase | string): string {
  switch (phase) {
    case "queued":
      return "…";
    case "running":
      return "▶";
    default:
      return "·";
  }
}

/** Bound preview that never returns the full long string when over max. */
export function boundPreview(text: string, max: number): string {
  const s = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(ms: number): string {
  const n = Math.max(0, safeNum(ms));
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(n / 60_000);
  const secs = Math.round((n % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function safeNum(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

// Re-export Theme type alias for callers that want the real class.
export type { Theme };
