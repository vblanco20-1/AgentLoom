import { describe, it, expect } from "bun:test";
import { pLimit } from "../src/util/pLimit.ts";
import { pipelineImpl } from "../src/primitives/pipeline.ts";
import { parallelImpl } from "../src/primitives/parallel.ts";
import { extractJson } from "../src/driver/schema.ts";

describe("pLimit", () => {
  it("caps concurrency", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () =>
      limit.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("pipelineImpl", () => {
  it("threads each item through every stage with originalItem + idx", async () => {
    const items = ["a", "b", "c"];
    const result = await pipelineImpl(
      items,
      (v, orig, idx) => `${v}|${orig}|${idx}`,
      async (v, orig) => `${v}/${orig}`,
    );
    expect(result).toEqual(["a|a|0/a", "b|b|1/b", "c|c|2/c"]);
  });

  it("supports per-item streaming (stage 2 can start before all stage 1 done)", async () => {
    const order: string[] = [];
    await pipelineImpl(
      [1, 2],
      async (v) => {
        order.push(`s1-start-${v}`);
        await new Promise((r) => setTimeout(r, v === 1 ? 40 : 10));
        order.push(`s1-end-${v}`);
        return v;
      },
      async (v) => {
        order.push(`s2-start-${v}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`s2-end-${v}`);
        return v;
      },
    );
    // item 2 finishes stage 1 before item 1 — its stage 2 must start before
    // item 1's stage 2.
    const i2s1End = order.indexOf("s1-end-2");
    const i2s2Start = order.indexOf("s2-start-2");
    const i1s2Start = order.indexOf("s2-start-1");
    expect(i2s2Start).toBeGreaterThan(i2s1End);
    expect(i2s2Start).toBeLessThan(i1s2Start);
  });
});

describe("parallelImpl", () => {
  it("runs all thunks and preserves order", async () => {
    const r = await parallelImpl([
      async () => 1,
      async () => "two",
      async () => ({ k: 3 }),
    ]);
    expect(r).toEqual([1, "two", { k: 3 }]);
  });
});

describe("extractJson", () => {
  it("parses strict JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips ```json fences", () => {
    expect(extractJson('```json\n{"b":2}\n```')).toEqual({ b: 2 });
  });
  it("finds the first balanced object in messy prose", () => {
    expect(extractJson('prelude {"c":3} epilogue')).toEqual({ c: 3 });
  });
  it("returns undefined when nothing parses", () => {
    expect(extractJson("not json at all")).toBeUndefined();
  });
});
