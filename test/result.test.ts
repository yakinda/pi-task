import { describe, expect, it } from "vitest";
import {
  codePointLength,
  encodeCdata,
  escapeXml,
  finalAssistantText,
  formatTruncationMarker,
  formatTruncationWarning,
  normalizeSuccessResult,
  packageSuccess,
  RESULT_SOFT_CAP,
  sanitizeXmlText,
  softCap,
  softCapWithMeta,
  TRUNCATION_MARKER_NEEDLE,
  utf8ByteLength,
} from "../src/result.ts";

/** Minimal XML parse for envelope contract tests. */
function parseTaskXml(xml: string): {
  state: string;
  summary: string;
  warnings: string[];
  taskResult: string;
} {
  const state = xml.match(/<task\s+state="([^"]+)">/)?.[1];
  if (!state) throw new Error("no state");
  const summary = xml.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "";
  const warningsBlock = xml.match(/<warnings>([\s\S]*?)<\/warnings>/)?.[1];
  const warnings: string[] = [];
  if (warningsBlock) {
    const re = /<warning>([\s\S]*?)<\/warning>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(warningsBlock))) warnings.push(decodeXml(m[1]!));
  }
  const resultMatch = xml.match(/<task_result>([\s\S]*)<\/task_result>/);
  let taskResult = resultMatch?.[1] ?? "";
  taskResult = taskResult.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return {
    state,
    summary: decodeXml(summary),
    warnings,
    taskResult,
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTruncationMarker(text: string): string {
  return text.replace(/\n\n\.\.\.\[truncated[^\]]*\]\.\.\.\n\n/g, "");
}

describe("finalAssistantText", () => {
  it("uses only the last assistant message and concatenates text parts in order", () => {
    const result = finalAssistantText([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "toolUse" },
      { role: "toolResult", content: [{ type: "text", text: "noise" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "part-a " },
          { type: "thinking", text: "secret" },
          { type: "text", text: "part-b" },
        ],
        stopReason: "stop",
      },
    ]);
    expect(result.found).toBe(true);
    expect(result.text).toBe("part-a part-b");
    expect(result.stopReason).toBe("stop");
  });

  it("does not return stale text when final assistant has no text", () => {
    const result = finalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "stale" }], stopReason: "toolUse" },
      {
        role: "assistant",
        content: [{ type: "toolCall" as any }],
        stopReason: "error",
        errorMessage: "boom",
      },
    ]);
    expect(result.found).toBe(true);
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("boom");
  });

  it("returns found=false when no assistant", () => {
    expect(finalAssistantText([{ role: "user", content: "hi" }]).found).toBe(false);
  });
});

describe("softCap (Unicode code points)", () => {
  it("leaves short text unchanged", () => {
    expect(softCap("hello")).toBe("hello");
  });

  it("leaves exact 8000 code points unchanged", () => {
    const exact = "x".repeat(RESULT_SOFT_CAP);
    expect(softCap(exact)).toBe(exact);
    expect(codePointLength(softCap(exact))).toBe(RESULT_SOFT_CAP);
    expect(softCapWithMeta(exact).truncated).toBe(false);
  });

  it("head+tail truncates oversize with size-aware marker within 8000 code points", () => {
    const big = "A".repeat(5000) + "B".repeat(5000);
    const meta = softCapWithMeta(big, 8000);
    expect(meta.truncated).toBe(true);
    expect(codePointLength(meta.text)).toBe(8000);
    expect(meta.text).toContain(TRUNCATION_MARKER_NEEDLE);
    expect(meta.text).toMatch(/retained \d+ of 10000 code points/);
    expect(meta.text).toMatch(/\d+ of \d+ UTF-8 bytes/);
    expect(meta.originalCodePoints).toBe(10000);
    expect(meta.retainedCodePoints).toBe(8000);
    expect(meta.originalUtf8Bytes).toBe(utf8ByteLength(big));
    expect(meta.retainedUtf8Bytes).toBe(utf8ByteLength(meta.text));
    expect(meta.text.startsWith("A")).toBe(true);
    expect(meta.text.endsWith("B")).toBe(true);
  });

  it("does not split astral Unicode characters and stays within limit", () => {
    const emoji = "😀";
    const big = emoji.repeat(5000);
    const out = softCap(big, 100);
    expect(codePointLength(out)).toBe(100);
    expect(out).toContain(TRUNCATION_MARKER_NEEDLE);
    const withoutMarker = stripTruncationMarker(out);
    for (const ch of withoutMarker) {
      expect(ch).toBe(emoji);
    }
  });

  it("exact 8001 code points truncates with marker including sizes", () => {
    const over = "x".repeat(RESULT_SOFT_CAP + 1);
    const meta = softCapWithMeta(over);
    expect(meta.truncated).toBe(true);
    expect(meta.originalCodePoints).toBe(RESULT_SOFT_CAP + 1);
    expect(meta.retainedCodePoints).toBe(RESULT_SOFT_CAP);
    expect(codePointLength(meta.text)).toBe(RESULT_SOFT_CAP);
    expect(meta.text).toMatch(
      new RegExp(`retained ${RESULT_SOFT_CAP} of ${RESULT_SOFT_CAP + 1} code points`),
    );
  });

  it("formatTruncationMarker embeds original and retained sizes", () => {
    const m = formatTruncationMarker({
      originalCodePoints: 9000,
      retainedCodePoints: 8000,
      originalUtf8Bytes: 9000,
      retainedUtf8Bytes: 8000,
    });
    expect(m).toContain("retained 8000 of 9000 code points");
    expect(m).toContain("8000 of 9000 UTF-8 bytes");
    expect(m).toContain(TRUNCATION_MARKER_NEEDLE);
  });
});

describe("XML helpers", () => {
  it("escapes special characters", () => {
    expect(escapeXml(`a<b>&"c"`)).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
  });

  it("sanitizes invalid XML control characters", () => {
    expect(sanitizeXmlText("ok\u0000bad\u0007")).toBe("okbad");
    expect(sanitizeXmlText("keep\t\n\r")).toBe("keep\t\n\r");
  });

  it("splits embedded ]]> in CDATA safely", () => {
    const encoded = encodeCdata("foo]]>bar");
    expect(encoded).toContain("]]>");
    const bodies = [...encoded.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
    expect(bodies.join("")).toBe("foo]]>bar");
  });
});

describe("packageSuccess envelope", () => {
  it("wraps completed result as parseable XML", () => {
    const xml = packageSuccess({ description: "search files", text: "found it" });
    const parsed = parseTaskXml(xml);
    expect(parsed.state).toBe("completed");
    expect(parsed.summary).toBe("search files");
    expect(parsed.taskResult).toBe("found it");
    expect(parsed.warnings).toEqual([]);
  });

  it("escapes XML special chars in summary/warnings", () => {
    const xml = packageSuccess({
      description: `a <b> & "c"`,
      text: "body",
      warnings: [`tool "x" <skipped> & more`],
    });
    const parsed = parseTaskXml(xml);
    expect(parsed.summary).toBe(`a <b> & "c"`);
    expect(parsed.warnings).toEqual([`tool "x" <skipped> & more`]);
  });

  it("handles result containing </task_result>, tags, entities, and ]]>", () => {
    const body = `</task_result><tag>&amp;]]>\nother`;
    const xml = packageSuccess({ description: "x", text: body });
    const parsed = parseTaskXml(xml);
    expect(parsed.taskResult).toBe(body);
  });

  it("sanitizes invalid control chars in result", () => {
    const xml = packageSuccess({ description: "x", text: "hi\u0000there" });
    const parsed = parseTaskXml(xml);
    expect(parsed.taskResult).toBe("hithere");
  });

  it("throws when only XML-invalid controls/whitespace remain after sanitation", () => {
    const blankAfterSanitize = "\u0000\u0007\uFFFE\uFFFF  \t\n";
    expect(sanitizeXmlText(blankAfterSanitize).trim()).toBe("");
    expect(() =>
      packageSuccess({ description: "x", text: blankAfterSanitize }),
    ).toThrow(/empty final assistant text/);
    expect(() =>
      normalizeSuccessResult({
        description: "x",
        text: blankAfterSanitize,
      }),
    ).toThrow(/empty final assistant text/);
  });

  it("truncated successful runs still completed with size warning", () => {
    const xml = packageSuccess({ description: "big", text: "Z".repeat(9000) });
    const parsed = parseTaskXml(xml);
    expect(parsed.state).toBe("completed");
    expect(parsed.taskResult).toContain(TRUNCATION_MARKER_NEEDLE);
    expect(codePointLength(parsed.taskResult)).toBe(RESULT_SOFT_CAP);
    expect(parsed.warnings.some((w) => /truncated/i.test(w))).toBe(true);
    expect(parsed.warnings.some((w) => /9000/.test(w) && /code points/.test(w))).toBe(true);
  });

  it("omits warnings block when empty", () => {
    const xml = packageSuccess({ description: "x", text: "y" });
    expect(xml).not.toContain("<warnings>");
  });

  it("includes warnings when present", () => {
    const xml = packageSuccess({
      description: "x",
      text: "y",
      warnings: ["w1", "w2"],
    });
    expect(xml).toContain("<warnings>");
    const parsed = parseTaskXml(xml);
    expect(parsed.warnings).toEqual(["w1", "w2"]);
  });

  it("empty final text fails", () => {
    expect(() => packageSuccess({ description: "x", text: "   " })).toThrow(
      /empty final assistant text/,
    );
  });

  it("supports legacy (description, text) call shape", () => {
    const xml = packageSuccess("legacy", "ok");
    expect(xml).toContain("ok");
  });
});

describe("normalizeSuccessResult — single bounded channel (Issue 5)", () => {
  it("short results: unchanged text, equal model/human channels, no truncation", () => {
    const n = normalizeSuccessResult({
      description: "short",
      text: "hello world",
    });
    expect(n.truncated).toBe(false);
    expect(n.resultText).toBe("hello world");
    expect(n.warnings).toEqual([]);
    const parsed = parseTaskXml(n.modelXml);
    expect(parsed.taskResult).toBe("hello world");
    expect(parsed.taskResult).toBe(n.resultText);
    expect(parsed.warnings).toEqual([]);
  });

  it("exactly 8000 code points: no truncation, channels equal", () => {
    const exact = "q".repeat(RESULT_SOFT_CAP);
    const n = normalizeSuccessResult({
      description: "exact",
      text: exact,
    });
    expect(n.truncated).toBe(false);
    expect(n.resultText).toBe(exact);
    expect(parseTaskXml(n.modelXml).taskResult).toBe(n.resultText);
    expect(codePointLength(n.resultText)).toBe(RESULT_SOFT_CAP);
  });

  it("results at or below the cap are unchanged apart from required XML-control sanitation", () => {
    const clean = "keep\t\n\r and ordinary text";
    const withControls = "ok\u0000body\uFFFE";
    const nClean = normalizeSuccessResult({ description: "clean", text: clean });
    expect(nClean.resultText).toBe(clean);
    expect(parseTaskXml(nClean.modelXml).taskResult).toBe(clean);

    const nMixed = normalizeSuccessResult({ description: "mixed", text: withControls });
    expect(nMixed.resultText).toBe("okbody");
    expect(parseTaskXml(nMixed.modelXml).taskResult).toBe("okbody");
    expect(nMixed.resultText).toBe(parseTaskXml(nMixed.modelXml).taskResult);
  });

  it("over 8000 code points: capped equal channels, head+tail, deterministic size warning", () => {
    const body = "A".repeat(5000) + "MIDDLE" + "B".repeat(5000);
    const n = normalizeSuccessResult({
      description: "over",
      text: body,
    });
    expect(n.truncated).toBe(true);
    const parsed = parseTaskXml(n.modelXml);
    expect(codePointLength(parsed.taskResult)).toBe(RESULT_SOFT_CAP);
    expect(parsed.taskResult).toContain(TRUNCATION_MARKER_NEEDLE);
    expect(parsed.taskResult).not.toContain("MIDDLE");
    // Exact equality: human details === model channel logical content
    expect(n.resultText).toBe(parsed.taskResult);
    expect(n.modelXml).not.toContain("resultText");
    expect(n.modelXml).not.toContain("<resultText");
    // Warning reports original/retained sizes
    expect(n.warnings.some((w) => /retained \d+ of \d+ Unicode code points/.test(w))).toBe(true);
    expect(n.warnings.some((w) => /\d+ of \d+ UTF-8 bytes/.test(w))).toBe(true);
    // Warning list identical in details and XML
    expect(parsed.warnings).toEqual(n.warnings);
    expect(n.warnings.some((w) => /artifact/i.test(w))).toBe(false);
  });

  it("astral Unicode over cap: code-point safe, channels equal", () => {
    const emoji = "😀";
    const body = emoji.repeat(RESULT_SOFT_CAP + 50);
    const n = normalizeSuccessResult({
      description: "emoji",
      text: body,
    });
    expect(n.truncated).toBe(true);
    expect(codePointLength(n.resultText)).toBe(RESULT_SOFT_CAP);
    expect(parseTaskXml(n.modelXml).taskResult).toBe(n.resultText);
    const withoutMarker = stripTruncationMarker(n.resultText);
    for (const ch of withoutMarker) {
      expect(ch).toBe(emoji);
    }
  });

  it("formatTruncationWarning is deterministic with original and retained sizes", () => {
    const w = formatTruncationWarning({
      originalCodePoints: 9000,
      retainedCodePoints: 8000,
      originalUtf8Bytes: 9000,
      retainedUtf8Bytes: 8000,
    });
    expect(w).toBe(
      formatTruncationWarning({
        originalCodePoints: 9000,
        retainedCodePoints: 8000,
        originalUtf8Bytes: 9000,
        retainedUtf8Bytes: 8000,
      }),
    );
    expect(w).toContain("retained 8000 of 9000 Unicode code points");
    expect(w).toContain("8000 of 9000 UTF-8 bytes");
    expect(w).not.toMatch(/artifact/i);
  });

  it("existing warnings are preserved alongside truncation warnings", () => {
    const n = normalizeSuccessResult({
      description: "w",
      text: "Y".repeat(9000),
      warnings: ["tool write skipped"],
    });
    expect(n.warnings[0]).toBe("tool write skipped");
    expect(n.warnings.some((w) => /truncated/i.test(w))).toBe(true);
    expect(parseTaskXml(n.modelXml).warnings).toEqual(n.warnings);
  });

  it("XML remains valid with CDATA-hostile content under truncation", () => {
    const body = "start]]>middle</task_result><evil>&amp;" + "Q".repeat(9000);
    const n = normalizeSuccessResult({
      description: "cdata",
      text: body,
    });
    const parsed = parseTaskXml(n.modelXml);
    expect(parsed.state).toBe("completed");
    expect(codePointLength(parsed.taskResult)).toBe(RESULT_SOFT_CAP);
    expect(parsed.taskResult.startsWith("start")).toBe(true);
    expect(n.resultText).toBe(parsed.taskResult);
  });

  it("control-heavy >8k: retained counts match decoded task_result (sanitized source)", () => {
    const validChunk = "V".repeat(100);
    const controlChunk = "\u0000\u0001\u0007\uFFFE\uFFFF".repeat(20);
    let raw = "";
    while (codePointLength(sanitizeXmlText(raw)) <= RESULT_SOFT_CAP + 200) {
      raw += validChunk + controlChunk;
    }
    const sanitized = sanitizeXmlText(raw);
    expect(codePointLength(raw)).toBeGreaterThan(codePointLength(sanitized));
    expect(codePointLength(sanitized)).toBeGreaterThan(RESULT_SOFT_CAP);

    const n = normalizeSuccessResult({
      description: "ctrl-heavy",
      text: raw,
    });

    expect(n.truncated).toBe(true);
    const parsed = parseTaskXml(n.modelXml);
    const decoded = parsed.taskResult;

    expect(codePointLength(decoded)).toBe(RESULT_SOFT_CAP);
    expect(decoded).toContain(TRUNCATION_MARKER_NEEDLE);
    expect(n.resultText).toBe(decoded);

    // Marker embeds sanitized retained/original counts
    expect(decoded).toMatch(
      new RegExp(`retained ${codePointLength(decoded)} of ${codePointLength(sanitized)} code points`),
    );

    // Warning uses the same sizes
    expect(
      n.warnings.some(
        (w) =>
          w.includes(
            `retained ${codePointLength(decoded)} of ${codePointLength(sanitized)} Unicode code points`,
          ),
      ),
    ).toBe(true);
    expect(parsed.warnings).toEqual(n.warnings);

    // Decoded task_result must not contain the stripped controls
    expect(decoded).not.toContain("\u0000");
    expect(decoded).not.toContain("\uFFFE");
  });

  it("no retention/artifact metadata fields on normalized result", () => {
    const n = normalizeSuccessResult({
      description: "meta",
      text: "Z".repeat(9000),
    });
    expect(n).not.toHaveProperty("artifact");
    expect(n).not.toHaveProperty("retention");
    expect(n).not.toHaveProperty("truncation");
    expect(n).not.toHaveProperty("modelTruncated");
    expect(JSON.stringify(n)).not.toMatch(/artifact|retention/i);
  });

  it("oversized multi-byte UTF-8 still soft-caps by code points with equal channels", () => {
    // "€" is 3 UTF-8 bytes and 1 code point
    const euro = "€";
    const body = euro.repeat(RESULT_SOFT_CAP + 100);
    expect(utf8ByteLength(body)).toBe((RESULT_SOFT_CAP + 100) * 3);
    const n = normalizeSuccessResult({ description: "euro", text: body });
    expect(n.truncated).toBe(true);
    expect(codePointLength(n.resultText)).toBe(RESULT_SOFT_CAP);
    expect(parseTaskXml(n.modelXml).taskResult).toBe(n.resultText);
  });
});
