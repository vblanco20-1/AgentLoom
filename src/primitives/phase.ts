import type { RunContext } from "./runtime.ts";
import { nowMs } from "../bus/events.ts";

export function makePhasePrimitive(ctx: RunContext) {
  return function phase(title: string): void {
    ctx.bus.emit({
      kind: "phase.mark",
      runId: ctx.runId,
      title,
      t: nowMs(),
    });
  };
}
