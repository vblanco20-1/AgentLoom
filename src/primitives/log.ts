import type { RunContext } from "./runtime.ts";
import { nowMs } from "../bus/events.ts";

export function makeLogPrimitive(ctx: RunContext) {
  return function log(msg: string, meta?: unknown): void {
    ctx.bus.emit({
      kind: "workflow.log",
      runId: ctx.runId,
      msg,
      meta,
      t: nowMs(),
    });
  };
}
