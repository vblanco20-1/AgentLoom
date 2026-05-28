import { schemaHash, type JSONSchema } from "../driver/schema.ts";
import type { AgentControl, RunContext } from "./runtime.ts";
import { poolForCwd } from "./runtime.ts";
import { uuid } from "../util/uuid.ts";
import { nowMs, type AgentTokenUsage } from "../bus/events.ts";
import { buildMemoryPrefix, ensureMemoryFile, resolveMemoryPath } from "../util/memoryFile.ts";

// Reported to the workflow via opts.onMetrics once the agent settles. Lets
// workflows track how much context they've burned and decide whether to keep
// pushing more data into a follow-up agent() call.
export interface AgentMetrics {
  agentId: string;
  ok: boolean;
  reason: string;
  elapsedMs: number;
  tokens: AgentTokenUsage;
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: JSONSchema;
  model?: { providerID: string; modelID: string };
  agent?: string;
  tools?: Record<string, boolean>;
  cwd?: string;
  timeoutMs?: number;
  // Override the runner-level default for how many times we feed a schema
  // error back to the AI before declaring the agent dead.
  maxSchemaRetries?: number;
  // Per-call shared-memory override. A string path overrides whatever
  // memory(path) set at the run level; `false` (or "") disables memory
  // for this call only. Omit to inherit the active run-level binding.
  memory?: string | false;
  // Fired once when the agent settles (ok or not) with a rough token
  // accounting for everything the runner pushed to opencode and got back —
  // user prompts (including schema retries), assistant text + reasoning,
  // and tool input args / outputs. Use it to decide whether to keep
  // feeding more data into a follow-up agent() call before you hit your
  // model's context window. Never throws; errors in the callback are
  // swallowed so they can't take the run down.
  onMetrics?: (m: AgentMetrics) => void;
}

// Permissive default schema applied to every agent() call that doesn't
// supply one. Forces JSON output across the board: the model is prompted
// to emit a JSON object (via describeSchemaForPrompt) and the server binds
// its native json_schema mode. Callers that need a strict shape pass their
// own schema; callers that just want "any JSON" get this.
const DEFAULT_SCHEMA: JSONSchema = {
  type: "object",
  description:
    "Respond with a JSON object. Use whatever keys make sense for the task.",
};

// Helper so we never let an exception in the workflow's metrics callback
// take the run down. The runner's whole contract is that agent() never
// throws — and that has to extend to anything we hand off to user code.
function fireMetrics(
  cb: AgentOptions["onMetrics"],
  ctx: RunContext,
  m: AgentMetrics,
): void {
  if (!cb) return;
  try {
    cb(m);
  } catch (err) {
    ctx.bus.emit({
      kind: "workflow.log",
      runId: ctx.runId,
      msg: `agent() onMetrics callback threw: ${(err as Error).message}`,
      t: nowMs(),
    });
  }
}

export function makeAgentPrimitive(ctx: RunContext) {
  const agentFn = async function agent(prompt: string, opts: AgentOptions = {}): Promise<unknown> {
    const agentId = uuid();
    const cwd = opts.cwd ?? ctx.config.defaultCwd;
    // Every launch enforces JSON. opts.schema overrides the default.
    const schema: JSONSchema = opts.schema ?? DEFAULT_SCHEMA;
    const sHash = schemaHash(schema);
    const tStart = nowMs();

    // Resolve effective memory binding for this call. Precedence:
    //   1. opts.memory === false  → no memory for this call
    //   2. opts.memory === string → use that path (override)
    //   3. ctx.activeMemory       → inherit run-level binding
    //   4. otherwise              → no memory
    let memoryAbs: string | null = null;
    if (opts.memory === false || opts.memory === "") {
      memoryAbs = null;
    } else if (typeof opts.memory === "string") {
      memoryAbs = resolveMemoryPath(opts.memory, cwd);
    } else if (ctx.activeMemory) {
      memoryAbs = resolveMemoryPath(ctx.activeMemory, cwd);
    }
    if (memoryAbs) await ensureMemoryFile(memoryAbs);
    const finalPrompt = memoryAbs ? `${buildMemoryPrefix(memoryAbs)}${prompt}` : prompt;
    // Register a control slot before we emit agent.start so the UI never
    // sees an agent it can't interact with. The slot's abort is a no-op
    // until the handle is created; retry is wired up right away.
    const control: AgentControl = {
      agentId,
      abort: async () => { /* not yet running */ },
      retry: async () => {
        // Re-launch the same prompt as a brand-new agent. We deliberately
        // don't await — the workflow only sees the original invocation's
        // result, and a UI-triggered retry is fire-and-forget so the user
        // can compare runs without blocking anything.
        void agentFn(prompt, opts);
      },
      ended: false,
    };
    ctx.agentControls.set(agentId, control);
    // First agent() launch freezes the workflow-registered tool list as far
    // as the sub-agent is concerned. opencode reads tools/list at
    // worktree-server boot and caches the result; tools registered past
    // this point never reach the model — defineTool emits a workflow.log
    // warning when this flag is set.
    ctx.runnerToolsLocked = true;
    ctx.bus.emit({
      kind: "agent.start",
      runId: ctx.runId,
      agentId,
      label: opts.label,
      phase: opts.phase,
      cwd,
      prompt,
      schemaHash: sHash,
      memoryPath: memoryAbs ?? undefined,
      t: tStart,
    });

    // Tier 1: global semaphore. Tier 2: per-worktree semaphore.
    const releaseGlobal = await ctx.agentPool.acquire();
    const release = await poolForCwd(ctx, cwd).acquire();

    let aborter: (() => Promise<void>) | null = null;
    try {
      const maxSchemaRetries = opts.maxSchemaRetries ?? ctx.config.maxSchemaRetries;
      const handle = await ctx.driver.run(cwd, {
        prompt: finalPrompt,
        schema,
        model: opts.model ?? ctx.config.defaultModel ?? undefined,
        agent: opts.agent ?? ctx.config.defaultAgent ?? undefined,
        tools: opts.tools,
        timeoutMs: opts.timeoutMs ?? ctx.config.agentTimeoutMs,
        maxSchemaRetries,
        onSessionAssigned: (sessionID, messageID) => {
          ctx.bus.emit({
            kind: "agent.session",
            runId: ctx.runId,
            agentId,
            sessionID,
            messageID,
            t: nowMs(),
          });
        },
        onTokenDelta: (partID, ordinal, delta) => {
          ctx.bus.emit({
            kind: "agent.token",
            runId: ctx.runId,
            agentId,
            partID,
            ordinal,
            delta,
            t: nowMs(),
          });
        },
        onReasoningDelta: (partID, ordinal, delta) => {
          ctx.bus.emit({
            kind: "agent.reasoning",
            runId: ctx.runId,
            agentId,
            partID,
            ordinal,
            delta,
            t: nowMs(),
          });
        },
        onToolStart: (call) => {
          ctx.bus.emit({
            kind: "agent.tool.start",
            runId: ctx.runId,
            agentId,
            callID: call.callID,
            ordinal: call.ordinal,
            tool: call.tool,
            input: call.input,
            t: nowMs(),
          });
        },
        onToolResult: (call) => {
          ctx.bus.emit({
            kind: "agent.tool.result",
            runId: ctx.runId,
            agentId,
            callID: call.callID,
            tool: call.tool,
            status: call.status === "error" ? "error" : "completed",
            output: call.output,
            error: call.error,
            elapsedMs: (call.endMs ?? Date.now()) - call.startMs,
            t: nowMs(),
          });
        },
        onUserPrompt: (attempt, text) => {
          ctx.bus.emit({
            kind: "agent.userPrompt",
            runId: ctx.runId,
            agentId,
            attempt,
            text,
            t: nowMs(),
          });
        },
        onSchemaRetry: (attempt, error) => {
          ctx.bus.emit({
            kind: "agent.schemaRetry",
            runId: ctx.runId,
            agentId,
            attempt,
            maxRetries: maxSchemaRetries,
            error,
            t: nowMs(),
          });
          ctx.bus.emit({
            kind: "workflow.log",
            runId: ctx.runId,
            msg: `agent() schema retry ${attempt}/${maxSchemaRetries}: ${error}`,
            t: nowMs(),
          });
        },
        onRawEvent: (evType, payload) => {
          // Catch-all firehose so the UI never silently drops an event from
          // opencode. Fires for EVERY event routed to this session — text,
          // reasoning, tool, and the long tail (todo.updated, file.edited,
          // session.status, step-start, step-finish, snapshot, patch, agent,
          // retry, compaction, etc.).
          ctx.bus.emit({
            kind: "agent.raw",
            runId: ctx.runId,
            agentId,
            evType,
            payload,
            t: nowMs(),
          });
        },
      });

      aborter = handle.abort;
      ctx.activeAborts.add(handle.abort);
      control.abort = handle.abort;
      const r = await handle.result;
      ctx.activeAborts.delete(handle.abort);

      if (r.ok) {
        ctx.bus.emit({
          kind: "agent.end",
          runId: ctx.runId,
          agentId,
          ok: true,
          reason: "idle",
          output: r.data,
          rawText: r.rawText,
          elapsedMs: r.elapsedMs,
          tokens: r.tokens,
          t: nowMs(),
        });
        fireMetrics(opts.onMetrics, ctx, { agentId, ok: true, reason: "idle", elapsedMs: r.elapsedMs, tokens: r.tokens });
        return r.data;
      }
      ctx.bus.emit({
        kind: "agent.end",
        runId: ctx.runId,
        agentId,
        ok: false,
        reason: r.reason,
        output: undefined,
        rawText: r.rawText,
        elapsedMs: r.elapsedMs,
        tokens: r.tokens,
        t: nowMs(),
      });
      fireMetrics(opts.onMetrics, ctx, { agentId, ok: false, reason: r.reason, elapsedMs: r.elapsedMs, tokens: r.tokens });
      if ((r as { message?: string }).message) {
        ctx.bus.emit({
          kind: "workflow.log",
          runId: ctx.runId,
          msg: `agent() ${r.reason}: ${(r as { message?: string }).message}`,
          t: nowMs(),
        });
      }
      return null;
    } catch (err) {
      // Contract: never throw. Any uncaught path resolves to null.
      ctx.bus.emit({
        kind: "agent.end",
        runId: ctx.runId,
        agentId,
        ok: false,
        reason: "internal",
        elapsedMs: nowMs() - tStart,
        t: nowMs(),
      });
      ctx.bus.emit({
        kind: "workflow.log",
        runId: ctx.runId,
        msg: `agent() swallowed error: ${(err as Error).message}`,
        t: nowMs(),
      });
      return null;
    } finally {
      if (aborter) ctx.activeAborts.delete(aborter);
      // Mark the control as ended so abort becomes a no-op, but keep the
      // retry closure usable for post-mortem re-runs from the UI.
      control.ended = true;
      control.abort = async () => { /* already ended */ };
      release();
      releaseGlobal();
    }
  };
  return agentFn;
}
