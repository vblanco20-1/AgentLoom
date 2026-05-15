import Ajv from "ajv";
import { createHash } from "node:crypto";

export type JSONSchema = Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

export function schemaHash(schema: JSONSchema): string {
  const stable = stableStringify(schema);
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

export function compileSchema(schema: JSONSchema): (data: unknown) => { ok: true; data: unknown } | { ok: false; errors: string[] } {
  const validate = ajv.compile(schema);
  return (data: unknown) => {
    if (validate(data)) return { ok: true, data };
    const errs = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors: errs };
  };
}

// Best-effort JSON extraction from raw assistant text. Even with opencode's
// native json_schema enforcement bound, models still routinely return prose
// wrapped around a fenced JSON block ("Here's your answer: ```json {...}```").
// We collect every plausible candidate, then return the first one that parses
// (or the first that satisfies the optional validator) — so a stray earlier
// non-JSON fence doesn't shadow a real JSON block later in the response.
export function extractJson(
  raw: string,
  options: { validate?: (data: unknown) => boolean } = {},
): unknown | undefined {
  if (!raw) return undefined;
  const s = raw.trim();

  const candidates: string[] = [];
  // 1) Whole-message strict parse — covers the well-behaved case.
  candidates.push(s);
  // 2) Every fenced code block (json-tagged or untagged), in source order.
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (const m of s.matchAll(fenceRe)) {
    const body = m[1];
    if (body) candidates.push(body.trim());
  }
  // 3) Every balanced top-level JSON value, scanning across the full text.
  //    Catches inline JSON like "Sure: { ... }" with no fences at all, and
  //    rescues us when an earlier fence held something that wasn't JSON.
  for (const c of scanBalanced(s, "{", "}")) candidates.push(c);
  for (const c of scanBalanced(s, "[", "]")) candidates.push(c);

  // When no validator is supplied, return the FIRST parseable candidate —
  // legacy behaviour; the caller has no schema constraint anyway.
  if (!options.validate) {
    for (const c of candidates) {
      try { return JSON.parse(c); } catch { continue; }
    }
    return undefined;
  }
  // With a validator, prefer the LAST validating candidate. Models tend to
  // structure responses with planning/intermediate notes first and the real
  // answer at the end, so the trailing valid candidate is usually the one
  // they meant. The validator already filters out tool-input echoes and
  // placeholder shapes that don't match the schema; ranking by source
  // position then picks the model's final, most-considered version.
  let firstParse: unknown | undefined = undefined;
  let lastValid: unknown | undefined = undefined;
  let haveLastValid = false;
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (firstParse === undefined) firstParse = parsed;
    if (options.validate(parsed)) {
      lastValid = parsed;
      haveLastValid = true;
    }
  }
  if (haveLastValid) return lastValid;
  // No candidate satisfied the validator — fall back to whatever parsed first
  // so the caller can surface a precise schema error to the model on retry.
  return firstParse;
}

// Returns every balanced (open, close) region in `s`, respecting JSON string
// escapes so braces inside string literals don't unbalance the scan. Used as
// a fallback when fenced blocks are missing, malformed, or contain non-JSON.
function scanBalanced(s: string, open: string, close: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(open, i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < s.length; j++) {
      const c = s[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    out.push(s.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

export function describeSchemaForPrompt(schema: JSONSchema): string {
  // The schema is inlined verbatim so the model can see field
  // descriptions; the instructions deliberately do NOT offer `{}` as an
  // escape hatch — that turned out to bait models into returning empty
  // objects with a "here is your answer" preamble, which then fail
  // validation on any non-trivial schema and burn a retry.
  return [
    "",
    "──────────────────────── RESPONSE FORMAT ────────────────────────",
    "Your ENTIRE response must be a single JSON value matching the schema",
    "below — and nothing else. Do NOT add prose. Do NOT add explanations.",
    "Do NOT wrap the JSON in markdown or code fences. Do NOT add a leading",
    "phrase like \"Here is your answer\". The first character of your reply",
    "must be `{` (or `[`) and the last character must be `}` (or `]`).",
    "Fill in every required field with real data from the task — never",
    "return an empty object as a stand-in.",
    "",
    "Schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
