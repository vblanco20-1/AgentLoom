import type { EventBus } from "../bus/EventBus.ts";
import type { OpencodeDriver } from "../driver/OpencodeDriver.ts";
import type { ResolvedRunnerConfig } from "../config/types.ts";
import { pLimit, type Limit } from "../util/pLimit.ts";

// One slot per agent() invocation: the live abort closure (null after the
// agent ends) plus a thunk that reissues the same prompt as a fresh agent.
// The UI calls these via WebSocket; primitives/agent.ts registers/unregisters
// them and primitives/agent.ts itself owns the retry implementation.
export interface AgentControl {
  agentId: string;
  abort: () => Promise<void>;
  retry: () => Promise<void>;
  // Set to true once the agent has emitted agent.end. Abort becomes a no-op,
  // but retry stays usable so the UI can re-run a finished/failed agent.
  ended: boolean;
}

// A workflow-registered tool. defineTool() stores these on the RunContext.
// The runner exposes them to opencode via an in-process MCP HTTP server;
// when the sub-agent invokes the tool, the server routes the call to the
// `handler` closure here, which runs in the same Bun process as the
// workflow.
export interface RunnerToolDef {
  name: string;
  description: string;
  // JSON Schema for the tool input (must be { type: "object", ... }).
  // We pass this through to MCP's tools/list verbatim so the model sees
  // whatever the workflow author wrote.
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  // The JS callback. Receives the validated tool input; returns either an
  // arbitrary JSON-serialisable value (which becomes the tool's text
  // content) or an explicit { content, isError? } MCP result.
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface RunContext {
  runId: string;
  bus: EventBus;
  driver: OpencodeDriver;
  config: ResolvedRunnerConfig;
  agentPool: Limit;
  perWorktreePool: Map<string, Limit>;
  // Surface for cli/run.ts to subscribe to aborts.
  activeAborts: Set<() => Promise<void>>;
  // Per-agent control surface keyed by agentId. The HTTP/WS layer reads this
  // to route "abort-agent" and "retry-agent" messages from the UI.
  agentControls: Map<string, AgentControl>;
  // Active shared-memory file for subsequent agent() calls. Set by the
  // workflow-level memory(path) primitive; null when memory is disabled.
  // Per-call agent({ memory }) overrides this without mutating it.
  activeMemory: string | null;
  // Workflow-registered tools. Mutated by defineTool() during workflow
  // execution; consulted by the in-process MCP server when opencode asks
  // for tools/list or tools/call.
  runnerTools: Map<string, RunnerToolDef>;
  // Locked once the first agent() launches. opencode's mcp/list is fetched
  // when the worktree server boots; tools added after that point are not
  // visible to the sub-agent. defineTool() raises a workflow.log warning
  // when called past this point.
  runnerToolsLocked: boolean;
}

export function makeRunContext(args: {
  runId: string;
  bus: EventBus;
  driver: OpencodeDriver;
  config: ResolvedRunnerConfig;
}): RunContext {
  return {
    runId: args.runId,
    bus: args.bus,
    driver: args.driver,
    config: args.config,
    agentPool: pLimit(args.config.maxAgentsTotal),
    perWorktreePool: new Map(),
    activeAborts: new Set(),
    agentControls: new Map(),
    activeMemory: null,
    runnerTools: new Map(),
    runnerToolsLocked: false,
  };
}

export function poolForCwd(ctx: RunContext, cwd: string): Limit {
  const existing = ctx.perWorktreePool.get(cwd);
  if (existing) return existing;
  const fresh = pLimit(ctx.config.maxAgentsPerWorktree);
  ctx.perWorktreePool.set(cwd, fresh);
  return fresh;
}
