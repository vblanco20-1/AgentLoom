import { WorktreeServer } from "./WorktreeServer.ts";
import { runPrompt, type PromptHandle, type PromptRequest } from "./promptRunner.ts";
import type { ResolvedRunnerConfig } from "../config/types.ts";

export class OpencodeDriver {
  private servers = new Map<string, WorktreeServer>();
  private cfg: ResolvedRunnerConfig;
  private shutdownDone = false;
  // Additional MCP entries to merge into config.mcp before opencode boots.
  // Used to inject the in-process RunnerToolServer (workflow-defined tools)
  // alongside any user-configured MCP servers.
  private extraMcp: Record<string, unknown> = {};

  constructor(cfg: ResolvedRunnerConfig) {
    this.cfg = cfg;
  }

  // Add an MCP server entry that will be merged into config.mcp at boot
  // time for every worktree opencode instance. Must be called BEFORE the
  // first run() — already-booted servers don't re-read this.
  addMcpServer(name: string, entry: unknown): void {
    this.extraMcp[name] = entry;
  }

  private async getServer(cwd: string): Promise<WorktreeServer> {
    const existing = this.servers.get(cwd);
    if (existing) {
      await existing.boot();
      return existing;
    }
    const mergedMcp: Record<string, unknown> = {
      ...(this.cfg.mcp ?? {}),
      ...this.extraMcp,
    };
    const server = new WorktreeServer({
      cwd,
      hostname: this.cfg.opencode.hostname,
      bootTimeoutMs: this.cfg.opencode.bootTimeoutMs,
      extraConfig: this.cfg.opencode.extraConfig,
      mcp: mergedMcp,
    });
    this.servers.set(cwd, server);
    await server.boot();
    return server;
  }

  async run(cwd: string, req: PromptRequest): Promise<PromptHandle> {
    const server = await this.getServer(cwd);
    return runPrompt(server, req);
  }

  // Forward a UI permission decision to the WorktreeServer that owns the
  // session. We don't know which cwd issued the requestID, so try every
  // booted server until one accepts. opencode's POST returns 404 if the
  // request isn't on that worker, which lets us iterate cheaply.
  async replyPermission(
    requestID: string,
    reply: "once" | "always" | "reject",
  ): Promise<{ ok: boolean; error?: string }> {
    let lastErr = "no booted worktree servers";
    for (const server of this.servers.values()) {
      const r = await server.replyPermission(requestID, reply);
      if (r.ok) return r;
      lastErr = r.error ?? lastErr;
    }
    return { ok: false, error: lastErr };
  }

  async shutdown(): Promise<void> {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    for (const s of this.servers.values()) {
      try {
        s.shutdown();
      } catch {
        // best effort
      }
    }
    this.servers.clear();
  }
}
