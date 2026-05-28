import { WorktreeServer } from "./WorktreeServer.ts";
import { runPrompt, type PromptHandle, type PromptRequest } from "./promptRunner.ts";
import type { ResolvedRunnerConfig } from "../config/types.ts";

// Caller-provided hook the driver consults the first time it boots an
// opencode worktree server. Returns the absolute path to an auto-generated
// opencode plugin file (or null if no plugin is needed). The plugin is the
// vehicle agent_runner uses to expose workflow-defined tools to the model
// under their bare names — see RunnerPluginFile.ts for the rationale.
//
// Why a callback instead of `setPluginPath(path)`: the plugin file content
// depends on every defineTool() the workflow ever calls, and those calls
// finish only just before the first agent() launch. So the driver resolves
// the path lazily in getServer(), giving the caller a chance to write the
// plugin file with the registry in its final shape. The provider's return
// value is cached for the lifetime of the driver — the file is regenerated
// at most once per process.
export type PluginPathProvider = () => Promise<string | null>;

export class OpencodeDriver {
  private servers = new Map<string, WorktreeServer>();
  private cfg: ResolvedRunnerConfig;
  private shutdownDone = false;
  // Additional MCP entries to merge into config.mcp before opencode boots.
  // Kept as an escape hatch for tests / external integrations that still
  // want an MCP server; the runner itself no longer registers its own
  // RunnerToolServer here — workflow tools flow through the plugin path
  // (see `pluginPathProvider`) so the model sees them under their bare
  // names instead of `__runner___<tool>`.
  private extraMcp: Record<string, unknown> = {};
  // Absolute plugin file paths (or file:// URLs) to feed to opencode's
  // `plugin` config option. Populated by `addPluginPath` and by the
  // lazy result of `pluginPathProvider`.
  private extraPlugins: string[] = [];
  private pluginPathProvider: PluginPathProvider | null = null;
  // Resolves to the path returned by the provider on its first call. We
  // cache the promise itself so concurrent getServer() invocations share a
  // single write of the plugin file.
  private pluginPathPromise: Promise<string | null> | null = null;

  constructor(cfg: ResolvedRunnerConfig) {
    this.cfg = cfg;
  }

  // Add an MCP server entry that will be merged into config.mcp at boot
  // time for every worktree opencode instance. Must be called BEFORE the
  // first run() — already-booted servers don't re-read this.
  addMcpServer(name: string, entry: unknown): void {
    this.extraMcp[name] = entry;
  }

  // Register an additional opencode plugin entry. `spec` is whatever
  // opencode's `plugin` config accepts (an absolute filesystem path, a
  // file:// URL, or an npm package name); the driver passes it through
  // unchanged. Use this for plugins that exist on disk independent of any
  // workflow tool registry. Workflow-defined tools should instead come in
  // via `setPluginPathProvider` so the driver can regenerate the file
  // with the final tool list at first-boot time.
  addPluginPath(spec: string): void {
    this.extraPlugins.push(spec);
  }

  // Install the lazy hook the driver calls the first time it needs to
  // boot an opencode worktree. See PluginPathProvider above.
  setPluginPathProvider(fn: PluginPathProvider): void {
    this.pluginPathProvider = fn;
  }

  private resolvePluginPath(): Promise<string | null> {
    if (this.pluginPathPromise) return this.pluginPathPromise;
    const fn = this.pluginPathProvider;
    if (!fn) {
      this.pluginPathPromise = Promise.resolve(null);
      return this.pluginPathPromise;
    }
    this.pluginPathPromise = (async () => {
      try {
        return await fn();
      } catch {
        return null;
      }
    })();
    return this.pluginPathPromise;
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
    const generatedPlugin = await this.resolvePluginPath();
    const plugins = [
      ...this.extraPlugins,
      ...(generatedPlugin ? [generatedPlugin] : []),
    ];
    const server = new WorktreeServer({
      cwd,
      hostname: this.cfg.opencode.hostname,
      bootTimeoutMs: this.cfg.opencode.bootTimeoutMs,
      extraConfig: this.cfg.opencode.extraConfig,
      mcp: mergedMcp,
      plugins: plugins.length > 0 ? plugins : undefined,
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
