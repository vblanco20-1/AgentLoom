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
}

export function makeAgentPrimitive(ctx: RunContext) {
  return async function agent(prompt: string, opts: AgentOptions = {}): Promise<unknown> {
    const agentId = uuid();
    const cwd = opts.cwd ?? ctx.config.defaultCwd;
    const sHash = opts.schema ? schemaHash(opts.schema) : undefined;
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
      const handle = await ctx.driver.run(cwd, {
        prompt,
        schema: opts.schema,
        model: opts.model ?? ctx.config.defaultModel ?? undefined,
        agent: opts.agent ?? ctx.config.defaultAgent ?? undefined,
        tools: opts.tools,
        timeoutMs: opts.timeoutMs ?? ctx.config.agentTimeoutMs,
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
