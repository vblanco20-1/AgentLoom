import { describe, it, expect } from "bun:test";
import { extractMeta } from "../src/workflow/meta.ts";
import { remapAsyncFunctionStack } from "../src/util/sourceMaps.ts";

describe("extractMeta", () => {
  it("extracts a basic meta and preserves line numbers", () => {
    const src = `export const meta = {
  name: "x",
  description: "y",
  phases: [{ title: "P1" }, { title: "P2" }],
};

log("hello");
return 1;
`;
    const r = extractMeta(src);
    expect(r.meta.name).toBe("x");
    expect(r.meta.phases?.length).toBe(2);
    // Both rewritten and original source must have the same number of newlines.
    expect(r.source.split("\n").length).toBe(src.split("\n").length);
    // Line 7 should still say `log("hello");`
    expect(r.source.split("\n")[6]).toContain('log("hello")');
  });

  it("rejects scripts with no meta", () => {
    expect(() => extractMeta('log("no meta");')).toThrow(/meta/);
  });

  it("validates meta.name", () => {
    expect(() =>
      extractMeta('export const meta = { name: 123 };'),
    ).toThrow();
  });
});

describe("remapAsyncFunctionStack", () => {
  it("rewrites <anonymous> and adjusts line numbers by -1", () => {
    const err = new Error("boom");
    err.stack =
      "Error: boom\n" +
      "    at <anonymous>:13:5\n" +
      "    at eval (<anonymous>:14:9)\n";
    remapAsyncFunctionStack(err, "/abs/path/foo.workflow.js");
    expect(err.stack).toContain("/abs/path/foo.workflow.js:12:5");
    expect(err.stack).toContain("/abs/path/foo.workflow.js:13:9");
  });
});
