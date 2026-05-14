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
  // How many times to feed a JSON / schema parse error back to the model
  // before declaring the agent dead. Default 5 (so up to 6 total attempts).
  maxSchemaRetries?: number;
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
  maxSchemaRetries: number;
  opencode: Required<OpencodeConfig>;
  mcp: Record<string, unknown>;
  web: Required<WebConfig>;
  runsDir: string;
  retention: Required<RetentionConfig>;
}
