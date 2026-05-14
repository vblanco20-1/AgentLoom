import type { ResolvedRunnerConfig, RunnerConfig } from "./types.ts";

export function resolveConfig(
  raw: RunnerConfig | undefined,
  cwdOverride: string,
): ResolvedRunnerConfig {
  const r = raw ?? {};
  return {
    defaultModel: r.defaultModel ?? null,
    defaultAgent: r.defaultAgent ?? null,
    defaultCwd: r.defaultCwd ?? cwdOverride,
    // Hard cap on concurrently-running agents — opencode worker startup
    // is heavy on Windows and 3+ parallel agents tend to thrash the SSE
    // stream. Two is the sweet spot for fan-out without saturating the box.
    maxAgentsTotal: r.maxAgentsTotal ?? 2,
    maxAgentsPerWorktree: r.maxAgentsPerWorktree ?? 2,
    agentTimeoutMs: r.agentTimeoutMs ?? 10 * 60 * 1000,
    maxSchemaRetries: r.maxSchemaRetries ?? 5,
    opencode: {
      binary: r.opencode?.binary ?? "opencode",
      hostname: r.opencode?.hostname ?? "127.0.0.1",
      bootTimeoutMs: r.opencode?.bootTimeoutMs ?? 30_000,
      extraConfig: r.opencode?.extraConfig ?? {},
    },
    mcp: r.mcp ?? {},
    web: {
      port: r.web?.port ?? 7777,
      openBrowser: r.web?.openBrowser ?? true,
    },
    runsDir: r.runsDir ?? ".runner/runs",
    retention: {
      maxRuns: r.retention?.maxRuns ?? 200,
    },
  };
}
