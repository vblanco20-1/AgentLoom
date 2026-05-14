import type { RunnerConfig } from "../src/config/types.ts";

const config: RunnerConfig = {
  // Pick the opencode provider/model you have credentials for.
  defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  defaultAgent: "build",
  defaultCwd: process.cwd(),

  // Concurrency
  maxAgentsTotal: 8,
  maxAgentsPerWorktree: 3,
  agentTimeoutMs: 10 * 60 * 1000,

  opencode: {
    binary: "opencode",
    hostname: "127.0.0.1",
    bootTimeoutMs: 30_000,
    extraConfig: { autoupdate: false, share: "disabled" },
  },

  mcp: {},

  web: { port: 7777, openBrowser: true },
  runsDir: ".runner/runs",
  retention: { maxRuns: 200 },
};

export default config;
