import { WorktreeServer } from "./WorktreeServer.ts";
import { runPrompt, type PromptHandle, type PromptRequest } from "./promptRunner.ts";
import type { ResolvedRunnerConfig } from "../config/types.ts";

export class OpencodeDriver {
  private servers = new Map<string, WorktreeServer>();
  private cfg: ResolvedRunnerConfig;
  private shutdownDone = false;

  constructor(cfg: ResolvedRunnerConfig) {
    this.cfg = cfg;
  }

  private async getServer(cwd: string): Promise<WorktreeServer> {
    const existing = this.servers.get(cwd);
    if (existing) {
      await existing.boot();
      return existing;
    }
    const server = new WorktreeServer({
      cwd,
      hostname: this.cfg.opencode.hostname,
      bootTimeoutMs: this.cfg.opencode.bootTimeoutMs,
      extraConfig: this.cfg.opencode.extraConfig,
      mcp: this.cfg.mcp,
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
