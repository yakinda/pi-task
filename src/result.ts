/**
 * Task result packaging — one normalized successful result.
 *
 * Pipeline order (Issue 5):
 * 1. Sanitize XML-invalid control characters
 * 2. Reject empty sanitized result (Task failure)
 * 3. Apply 8,000-Unicode-code-point head+tail soft-cap
 * 4. Package XML envelope
 *
 * The exact same capped text is both XML `<task_result>` logical content and
 * `TaskDetails.resultText`. Oversized output remains successful and adds a
 * deterministic original/retained-size warning. Operational errors throw;
 * never wrap failures in completed XML.
 */

/** Soft-cap limit for result text (Unicode code points). */
export const RESULT_SOFT_CAP = 8000;

/**
 * Recognizable truncation marker core (legacy + tests).
 * The full marker embeds original/retained size metadata — see {@link formatTruncationMarker}.
 */
export const TRUNCATION_MARKER = "\n\n...[truncated]...\n\n";

/** Substring always present in size-aware truncation markers. */
export const TRUNCATION_MARKER_NEEDLE = "...[truncated";

export const SUMMARY_MAX_CHARS = 120;

export interface MessageLike {
  role: string;
  content?: Array<{ type: string; text?: string }> | string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Extract final assistant message text by concatenating all text parts
 * of the last assistant message in order. Does not scan earlier turns.
 */
export function finalAssistantText(messages: readonly MessageLike[]): {
  text: string;
  stopReason?: string;
  errorMessage?: string;
  found: boolean;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return {
      text: extractAllText(msg),
      stopReason: msg.stopReason,
      errorMessage: msg.errorMessage,
      found: true,
    };
  }
  return { text: "", found: false };
}

function extractAllText(msg: MessageLike): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

/** Count Unicode code points (not UTF-16 code units). */
export function codePointLength(text: string): number {
  return [...text].length;
}

/** UTF-8 byte length. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface SoftCapResult {
  text: string;
  truncated: boolean;
  /** Code points of the soft-cap input (sanitized source). */
  originalCodePoints: number;
  retainedCodePoints: number;
  originalUtf8Bytes: number;
  retainedUtf8Bytes: number;
}

export interface TruncationMarkerMeta {
  originalCodePoints: number;
  retainedCodePoints: number;
  originalUtf8Bytes: number;
  retainedUtf8Bytes: number;
}

/**
 * Build an explicit truncation marker with original and retained sizes.
 * Sizes describe the logical sanitized text that enters `<task_result>`.
 */
export function formatTruncationMarker(meta: TruncationMarkerMeta): string {
  const body =
    `retained ${meta.retainedCodePoints} of ${meta.originalCodePoints}` +
    ` code points; ${meta.retainedUtf8Bytes} of ${meta.originalUtf8Bytes} UTF-8 bytes`;
  return `\n\n...[truncated: ${body}]...\n\n`;
}

/**
 * Soft-cap with head + tail retention and an explicit size-aware truncation marker.
 * Cap is measured in Unicode code points; surrogate pairs are never split.
 * When truncated, the returned text is at most `limit` code points (including marker).
 * Truncation alone does not mark failure.
 */
export function softCap(text: string, limit = RESULT_SOFT_CAP): string {
  return softCapWithMeta(text, limit).text;
}

/**
 * Soft-cap returning truncation metadata (code points + UTF-8 bytes).
 * Marker embeds original and retained sizes of `text` (the soft-cap input);
 * total result ≤ limit code points.
 */
export function softCapWithMeta(text: string, limit = RESULT_SOFT_CAP): SoftCapResult {
  const chars = [...text];
  const originalCodePoints = chars.length;
  const originalUtf8Bytes = utf8ByteLength(text);

  if (originalCodePoints <= limit) {
    return {
      text,
      truncated: false,
      originalCodePoints,
      retainedCodePoints: originalCodePoints,
      originalUtf8Bytes,
      retainedUtf8Bytes: originalUtf8Bytes,
    };
  }

  // Retained sizes appear inside the marker; digit width can change the head/tail
  // budget. Iterate until the marker's reported sizes match the capped body.
  let retainedCodePoints = limit;
  let retainedUtf8Bytes = originalUtf8Bytes;
  let capped = text;

  for (let pass = 0; pass < 8; pass++) {
    const marker = formatTruncationMarker({
      originalCodePoints,
      retainedCodePoints,
      originalUtf8Bytes,
      retainedUtf8Bytes,
    });
    capped = applyHeadTailCap(chars, limit, marker);
    const nextCp = codePointLength(capped);
    const nextBytes = utf8ByteLength(capped);
    if (nextCp === retainedCodePoints && nextBytes === retainedUtf8Bytes) {
      break;
    }
    retainedCodePoints = nextCp;
    retainedUtf8Bytes = nextBytes;
  }

  return {
    text: capped,
    truncated: true,
    originalCodePoints,
    retainedCodePoints: codePointLength(capped),
    originalUtf8Bytes,
    retainedUtf8Bytes: utf8ByteLength(capped),
  };
}

function applyHeadTailCap(chars: string[], limit: number, marker: string): string {
  const markerChars = [...marker];
  if (markerChars.length >= limit) {
    // Degenerate: marker alone exceeds budget — hard-cut original (should not happen at 8000).
    return chars.slice(0, limit).join("");
  }
  const budget = limit - markerChars.length;
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  return chars.slice(0, headLen).join("") + marker + chars.slice(chars.length - tailLen).join("");
}

/** Remove XML 1.0-invalid control characters (keep tab/LF/CR). */
export function sanitizeXmlText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

/** Escape text for XML element content. */
export function escapeXml(text: string): string {
  return sanitizeXmlText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Encode text as one or more CDATA sections, safely splitting embedded `]]>`.
 * Re-sanitizes as a defense-in-depth guard.
 */
export function encodeCdata(text: string): string {
  const sanitized = sanitizeXmlText(text);
  if (!sanitized.includes("]]>")) {
    return `<![CDATA[${sanitized}]]>`;
  }
  // Split on ]]> → ...]] + CDATA end + CDATA start + >...
  const parts = sanitized.split("]]>");
  return parts
    .map((part, i) => {
      if (i === parts.length - 1) return `<![CDATA[${part}]]>`;
      return `<![CDATA[${part}]]]]><![CDATA[>]]>`;
    })
    .join("");
}

export interface PackageSuccessInput {
  description: string;
  text: string;
  warnings?: string[];
}

export interface NormalizedSuccessResult {
  /** Model-visible valid XML envelope. */
  modelXml: string;
  /**
   * Exact normalized capped text (same logical content as XML `<task_result>`).
   * Human-visible details and model channel share this one representation.
   */
  resultText: string;
  /** Deduped warnings including truncation advisories. */
  warnings: string[];
  /** True when the soft-cap was applied. */
  truncated: boolean;
}

/**
 * One normalization pass for a successful child answer.
 *
 * Order: sanitize XML-invalid controls → empty validation → 8,000-code-point
 * head+tail soft-cap → XML packaging. `resultText` equals the logical
 * `<task_result>` body. Oversized results stay completed with a size warning.
 * Empty sanitized text throws (Task failure).
 */
export function normalizeSuccessResult(input: PackageSuccessInput): NormalizedSuccessResult {
  const description = input.description;
  const rawText = input.text;
  const baseWarnings = input.warnings ?? [];

  // Sanitize BEFORE empty validation and soft-cap measurement so marker/retained
  // sizes match the logical `<task_result>` body after CDATA parse.
  const sanitized = sanitizeXmlText(rawText);

  if (!sanitized.trim()) {
    throw new Error("Task failed: child produced empty final assistant text");
  }

  const cap = softCapWithMeta(sanitized, RESULT_SOFT_CAP);
  const warnings = [...baseWarnings];

  if (cap.truncated) {
    warnings.push(
      formatTruncationWarning({
        originalCodePoints: cap.originalCodePoints,
        retainedCodePoints: cap.retainedCodePoints,
        originalUtf8Bytes: cap.originalUtf8Bytes,
        retainedUtf8Bytes: cap.retainedUtf8Bytes,
      }),
    );
  }

  // Same capped text for human details and model channel.
  const resultText = cap.text;
  const modelXml = buildSuccessXml({
    description,
    cappedText: resultText,
    warnings,
  });

  return {
    modelXml,
    resultText,
    warnings,
    truncated: cap.truncated,
  };
}

/**
 * Deterministic Warning when result text is soft-capped.
 * Reports original and retained sizes; Task remains completed.
 */
export function formatTruncationWarning(cap: {
  originalCodePoints: number;
  retainedCodePoints: number;
  originalUtf8Bytes: number;
  retainedUtf8Bytes: number;
}): string {
  const sizes =
    `retained ${cap.retainedCodePoints} of ${cap.originalCodePoints} Unicode code points` +
    ` (${cap.retainedUtf8Bytes} of ${cap.originalUtf8Bytes} UTF-8 bytes)`;
  return `Task result truncated for model context: ${sizes}.`;
}

function buildSuccessXml(input: {
  description: string;
  cappedText: string;
  warnings: string[];
}): string {
  const summary = escapeXml(input.description.slice(0, SUMMARY_MAX_CHARS));
  // cappedText is already XML-sanitized by normalizeSuccessResult; encodeCdata
  // re-sanitizes as defense-in-depth without changing logical content.
  const cdata = encodeCdata(input.cappedText);

  const lines = [
    `<task state="completed">`,
    `<summary>${summary}</summary>`,
  ];

  if (input.warnings.length > 0) {
    lines.push(`<warnings>`);
    for (const w of input.warnings) {
      lines.push(`  <warning>${escapeXml(w)}</warning>`);
    }
    lines.push(`</warnings>`);
  }

  lines.push(`<task_result>${cdata}</task_result>`);
  lines.push(`</task>`);
  return lines.join("\n");
}

/**
 * Package a successful child final text as a valid XML envelope.
 * Empty text is a task failure (throw).
 *
 * Prefer {@link normalizeSuccessResult} when both XML and `resultText` are needed.
 */
export function packageSuccess(input: PackageSuccessInput | string, finalText?: string): string {
  // Support legacy (description, finalText) call shape during migration of callers
  let description: string;
  let text: string;
  let warnings: string[] = [];

  if (typeof input === "string") {
    description = input;
    text = finalText ?? "";
  } else {
    description = input.description;
    text = input.text;
    warnings = input.warnings ?? [];
  }

  return normalizeSuccessResult({
    description,
    text,
    warnings,
  }).modelXml;
}
