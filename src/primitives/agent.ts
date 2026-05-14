import { schemaHash, type JSONSchema } from "../driver/schema.ts";
import type { RunContext } from "./runtime.ts";
import { poolForCwd } from "./runtime.ts";
import { uuid } from "../util/uuid.ts";
import { nowMs } from "../bus/events.ts";

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

export function makeAgentPrimitive(ctx: RunContext) {
  return async function agent(prompt: string, opts: AgentOptions = {}): Promise<unknown> {
    const agentId = uuid();
    const cwd = opts.cwd ?? ctx.config.defaultCwd;
    // Every launch enforces JSON. opts.schema overrides the default.
    const schema: JSONSchema = opts.schema ?? DEFAULT_SCHEMA;
    const sHash = schemaHash(schema);
    const tStart = nowMs();
    ctx.bus.emit({
      kind: "agent.start",
      runId: ctx.runId,
      agentId,
      label: opts.label,
      phase: opts.phase,
      cwd,
      prompt,
      schemaHash: sHash,
      t: tStart,
    });

    // Tier 1: global semaphore. Tier 2: per-worktree semaphore.
    const releaseGlobal = await ctx.agentPool.acquire();
    const release = await poolForCwd(ctx, cwd).acquire();

    let aborter: (() => Promise<void>) | null = null;
    try {
      const maxSchemaRetries = opts.maxSchemaRetries ?? ctx.config.maxSchemaRetries;
      const handle = await ctx.driver.run(cwd, {
        prompt,
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
          t: nowMs(),
        });
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
        t: nowMs(),
      });
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
      release();
      releaseGlobal();
    }
  };
}
