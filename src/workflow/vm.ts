import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { extractMeta } from "./meta.ts";
import { remapAsyncFunctionStack } from "../util/sourceMaps.ts";
import type { WorkflowMeta } from "../bus/events.ts";

export interface WorkflowGlobals {
  agent: (prompt: string, opts?: unknown) => Promise<unknown>;
  pipeline: (items: unknown[], ...stages: Array<(...args: unknown[]) => unknown>) => Promise<unknown[]>;
  parallel: (thunks: Array<() => unknown>) => Promise<unknown[]>;
  phase: (title: string) => void;
  memory: (path?: string | null) => string | null;
  log: (msg: string, meta?: unknown) => void;
  // defineTool(name, { description, inputSchema }, handler) — register a
  // workflow-callable tool exposed to sub-agents. Must be called BEFORE
  // the first agent() invocation; opencode reads tools/list once at
  // worktree-server boot.
  defineTool: (
    name: string,
    opts: { description: string; inputSchema: { type: "object"; [k: string]: unknown } },
    handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => void;
  args: unknown;
}

export interface LoadedWorkflow {
  path: string;
  sha256: string;
  meta: WorkflowMeta;
  source: string; // rewritten, line-preserving
}

export async function loadWorkflow(path: string): Promise<LoadedWorkflow> {
  const abs = resolve(path);
  const raw = await readFile(abs, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const { meta, source } = extractMeta(raw);
  return { path: abs, sha256, meta, source };
}

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;

export async function runWorkflow(
  wf: LoadedWorkflow,
  globals: WorkflowGlobals,
): Promise<{ ok: true; result: unknown } | { ok: false; error: Error }> {
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunctionCtor(
      "agent",
      "pipeline",
      "parallel",
      "phase",
      "memory",
      "log",
      "defineTool",
      "args",
      wf.source,
    );
  } catch (err) {
    const e = remapAsyncFunctionStack(err as Error, wf.path);
    return { ok: false, error: e };
  }

  try {
    const result = await fn(
      globals.agent,
      globals.pipeline,
      globals.parallel,
      globals.phase,
      globals.memory,
      globals.log,
      globals.defineTool,
      globals.args,
    );
    return { ok: true, result };
  } catch (err) {
    const e = remapAsyncFunctionStack(err as Error, wf.path);
    return { ok: false, error: e };
  }
}
