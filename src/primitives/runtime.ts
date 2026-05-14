import type { EventBus } from "../bus/EventBus.ts";
import type { OpencodeDriver } from "../driver/OpencodeDriver.ts";
import type { ResolvedRunnerConfig } from "../config/types.ts";
import { pLimit, type Limit } from "../util/pLimit.ts";

export interface RunContext {
  runId: string;
  bus: EventBus;
  driver: OpencodeDriver;
  config: ResolvedRunnerConfig;
  agentPool: Limit;
  perWorktreePool: Map<string, Limit>;
  // Surface for cli/run.ts to subscribe to aborts.
  activeAborts: Set<() => Promise<void>>;
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
  };
}

export function poolForCwd(ctx: RunContext, cwd: string): Limit {
  const existing = ctx.perWorktreePool.get(cwd);
  if (existing) return existing;
  const fresh = pLimit(ctx.config.maxAgentsPerWorktree);
  ctx.perWorktreePool.set(cwd, fresh);
  return fresh;
}
