import type { RunContext } from "./runtime.ts";
import { nowMs } from "../bus/events.ts";

// `memory(path)` — sets the run-wide shared-memory file path for every
// subsequent agent() call. `memory(null)` (or no args) clears it.
//
// The path can be absolute or relative; agent() resolves a relative path
// against the agent's cwd at invocation time, so the same workflow can run
// against different worktrees and each agent sees a worktree-local file.
//
// The runner does NOT read or parse the memory file — it just guarantees
// the file exists and injects a prompt prefix that tells the agent to read
// it before working and append findings after. Concurrency is by
// convention: parallel agents sharing one file must agree to append, never
// overwrite. Workflow authors who need stricter isolation pass distinct
// paths per branch via the per-call `agent({ memory: "..." })` override.
export function makeMemoryPrimitive(ctx: RunContext) {
  return function memory(path?: string | null): string | null {
    const next = path && typeof path === "string" && path.length > 0 ? path : null;
    if (next !== ctx.activeMemory) {
      ctx.activeMemory = next;
      ctx.bus.emit({
        kind: "memory.set",
        runId: ctx.runId,
        path: next,
        t: nowMs(),
      });
    }
    return ctx.activeMemory;
  };
}
