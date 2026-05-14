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

// Best-effort JSON extraction from raw assistant text. The Bun-port runtime is
// observed to *accept* fenced/unfenced JSON and to *yield null* on any parse
// or schema failure. This mirrors that behaviour exactly.
export function extractJson(raw: string): unknown | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  // Try strict parse first.
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  // Strip ``` fences.
  const fenced = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch {
      // fall through
    }
  }
  // Balanced-braces scan for the first top-level { ... }.
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function describeSchemaForPrompt(schema: JSONSchema): string {
  // The Bun-port runtime almost certainly inlines the schema (with
  // `description` strings) into a system prompt. We do the same — verbatim
  // JSON in a fenced block, with explicit "respond with JSON only" guidance.
  return [
    "",
    "──────────────────────── RESPONSE FORMAT ────────────────────────",
    "Respond with a single JSON object matching this JSON Schema and",
    "nothing else. No prose, no markdown, no code fences. If you cannot",
    "comply, emit `{}` rather than free text.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
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
