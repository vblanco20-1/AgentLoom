import { describe, it, expect } from "bun:test";
import { compileSchema, extractJson } from "../src/driver/schema.ts";

describe("extractJson", () => {
  it("parses a plain JSON message", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("extracts a fenced ```json``` block surrounded by prose", () => {
    const raw = 'Here is your answer:\n\n```json\n{"ok": true}\n```\n\nAnything else?';
    expect(extractJson(raw)).toEqual({ ok: true });
  });

  it("extracts a single-line fenced block (the format that was failing in production)", () => {
    const raw = "here is your answer ```json {\"ok\": true}```";
    expect(extractJson(raw)).toEqual({ ok: true });
  });

  it("skips an earlier non-JSON fenced block and finds the later JSON one", () => {
    const raw = "First a code sample:\n```\nnot json at all\n```\nthen the answer:\n```json\n{\"x\": 1}\n```";
    expect(extractJson(raw)).toEqual({ x: 1 });
  });

  it("falls back to balanced-braces when no fences are present", () => {
    const raw = 'Sure thing: { "answer": 42, "nested": { "deep": [1, 2, 3] } }';
    expect(extractJson(raw)).toEqual({ answer: 42, nested: { deep: [1, 2, 3] } });
  });

  it("ignores braces inside string literals when scanning", () => {
    const raw = 'reply: {"msg": "this has } a literal brace"}';
    expect(extractJson(raw)).toEqual({ msg: "this has } a literal brace" });
  });

  it("returns undefined when nothing parses", () => {
    expect(extractJson("I cannot help with that.")).toBeUndefined();
  });

  it("prefers the schema-valid candidate when given a validator", () => {
    // First candidate is an empty object the model dropped in as a placeholder;
    // the second is the real answer in a fenced block. Without the validator,
    // we'd return the placeholder and the caller would have to retry.
    const raw = "Initial draft: {} ... let me refine: ```json\n{\"name\": \"Alice\"}\n```";
    const validate = compileSchema({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    const out = extractJson(raw, { validate: (d) => validate(d).ok });
    expect(out).toEqual({ name: "Alice" });
  });

  it("returns the first parseable candidate when none satisfy the validator", () => {
    // Lets the caller surface a precise schema error to the model rather than
    // a generic "no JSON found" — the retry prompt then includes the bad
    // shape and the validator complaint, which is much easier to fix.
    const raw = "Here: ```json\n{\"name\": 42}\n```";
    const validate = compileSchema({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    const out = extractJson(raw, { validate: (d) => validate(d).ok });
    expect(out).toEqual({ name: 42 });
  });

  it("extracts JSON arrays as well as objects", () => {
    expect(extractJson("Answer: [1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("prefers the LAST validating candidate, so a tool-input echo earlier in a multi-step trace doesn't beat the real answer", () => {
    // Realistic finalText() from a complex agent: step 1 planned a tool call
    // and echoed the tool's args inline, step 2 emitted the actual answer in
    // a fenced block. With permissive default schema, both objects validate;
    // the FIRST one would win without the last-wins rule.
    const raw = [
      "I'll start by reading the config with {\"file\": \"package.json\"}.",
      "Then I'll pick out the version field.",
      "",
      "```json",
      "{\"version\": \"0.1.0\", \"name\": \"agent-runner\"}",
      "```",
    ].join("\n");
    const validate = compileSchema({ type: "object" });
    const out = extractJson(raw, { validate: (d) => validate(d).ok });
    expect(out).toEqual({ version: "0.1.0", name: "agent-runner" });
  });

  it("prefers the LAST validating candidate when multiple fenced JSON blocks all validate", () => {
    // Model iterated through drafts before settling. Without last-wins, the
    // first draft would be returned even though the model intended the last.
    const raw = [
      "Initial attempt:",
      "```json",
      "{\"answer\": \"draft\"}",
      "```",
      "On reflection, let me refine:",
      "```json",
      "{\"answer\": \"final\"}",
      "```",
    ].join("\n");
    const validate = compileSchema({
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
    });
    const out = extractJson(raw, { validate: (d) => validate(d).ok });
    expect(out).toEqual({ answer: "final" });
  });
});
