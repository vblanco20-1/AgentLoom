import type { RunContext, RunnerToolDef } from "./runtime.ts";
import { nowMs } from "../bus/events.ts";

// Public option shape for defineTool(). We keep this minimal and align it
// 1:1 with MCP's tool descriptor so the workflow author writes one schema
// and we hand it straight to opencode via tools/list. `inputSchema` MUST
// be a JSON Schema with `type: "object"` — that's the only shape MCP's
// CallTool path validates against.
export interface DefineToolOptions {
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

export type DefineToolHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

// `defineTool(name, opts, handler)` — register a workflow-callable tool.
// Must be invoked BEFORE the first agent() call: opencode reads its MCP
// tool list once at worktree-server boot, so additions after that point
// are invisible to the sub-agent. After the first agent() launches we lock
// the registry and emit a workflow.log warning if a late defineTool() is
// attempted (we still record it so a UI inspection of the run shows the
// intent, even though that tool will never appear to the model).
export function makeDefineToolPrimitive(ctx: RunContext) {
  return function defineTool(
    name: string,
    opts: DefineToolOptions,
    handler: DefineToolHandler,
  ): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("defineTool: name must be a non-empty string");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      // Restrict the name to characters MCP and most tokenizers handle
      // without escaping. The model invokes tools by name, so quirky
      // characters there silently break tool calls.
      throw new Error(`defineTool: name must match /[A-Za-z0-9_.-]+/, got ${JSON.stringify(name)}`);
    }
    if (!opts || typeof opts.description !== "string" || opts.description.length === 0) {
      throw new Error(`defineTool(${name}): opts.description is required`);
    }
    if (
      !opts.inputSchema ||
      typeof opts.inputSchema !== "object" ||
      (opts.inputSchema as { type?: unknown }).type !== "object"
    ) {
      throw new Error(`defineTool(${name}): opts.inputSchema must be a JSON Schema with type:"object"`);
    }
    if (typeof handler !== "function") {
      throw new Error(`defineTool(${name}): handler must be a function`);
    }
    if (ctx.runnerTools.has(name)) {
      throw new Error(`defineTool: a tool named ${JSON.stringify(name)} is already registered`);
    }

    const def: RunnerToolDef = {
      name,
      description: opts.description,
      inputSchema: opts.inputSchema,
      handler,
    };
    ctx.runnerTools.set(name, def);

    if (ctx.runnerToolsLocked) {
      // Surface a loud signal — silent acceptance would let the workflow
      // author believe the tool is callable when it isn't.
      ctx.bus.emit({
        kind: "workflow.log",
        runId: ctx.runId,
        msg: `defineTool(${name}): registered AFTER first agent() — tool will NOT be visible to sub-agents (opencode reads tools/list once at worktree boot).`,
        t: nowMs(),
      });
    }
  };
}
