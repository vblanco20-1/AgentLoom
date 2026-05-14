export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface OpencodeConfig {
  binary?: string;
  hostname?: string;
  bootTimeoutMs?: number;
  extraConfig?: Record<string, unknown>;
}

export interface WebConfig {
  port?: number;
  openBrowser?: boolean;
}

export interface RetentionConfig {
  maxRuns?: number;
}

export interface RunnerConfig {
  defaultModel?: ModelRef;
  defaultAgent?: string;
  defaultCwd?: string;
  maxAgentsTotal?: number;
  maxAgentsPerWorktree?: number;
  agentTimeoutMs?: number;
  opencode?: OpencodeConfig;
  mcp?: Record<string, unknown>;
  web?: WebConfig;
  runsDir?: string;
  retention?: RetentionConfig;
}

export interface ResolvedRunnerConfig {
  defaultModel: ModelRef | null;
  defaultAgent: string | null;
  defaultCwd: string;
  maxAgentsTotal: number;
  maxAgentsPerWorktree: number;
  agentTimeoutMs: number;
  opencode: Required<OpencodeConfig>;
  mcp: Record<string, unknown>;
  web: Required<WebConfig>;
  runsDir: string;
  retention: Required<RetentionConfig>;
}
