import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/loadConfig.ts";
import { resolveConfig } from "../config/defaults.ts";
import { loadWorkflow, runWorkflow } from "../workflow/vm.ts";
import { EventBus } from "../bus/EventBus.ts";
import { OpencodeDriver } from "../driver/OpencodeDriver.ts";
import { startRunnerToolServer, type RunnerToolServerHandle } from "../driver/RunnerToolServer.ts";
import { writeRunnerPluginFile } from "../driver/RunnerPluginFile.ts";
import { join as joinPath } from "node:path";
import { makeRunContext } from "../primitives/runtime.ts";
import { makeAgentPrimitive } from "../primitives/agent.ts";
import { pipelineImpl } from "../primitives/pipeline.ts";
import { parallelImpl } from "../primitives/parallel.ts";
import { makePhasePrimitive } from "../primitives/phase.ts";
import { makeMemoryPrimitive } from "../primitives/memory.ts";
import { makeLogPrimitive } from "../primitives/log.ts";
import { makeDefineToolPrimitive } from "../primitives/tool.ts";
import { RunStore, isIncrementalEvent } from "../runs/RunStore.ts";
import { AgentLogStore } from "../runs/AgentLogStore.ts";
import { startHttpServer } from "../server/http.ts";
import { uuid } from "../util/uuid.ts";
import { nowMs } from "../bus/events.ts";

export interface RunOptions {
  workflowPath: string;
  argsFile?: string;
  argsJson?: string;
  config?: string;
  webPort?: number;
  noWeb?: boolean;
  noOpen?: boolean;
  runsDir?: string;
  cwd?: string;
  logLevel?: string;
}

export async function runCli(opts: RunOptions): Promise<number> {
  const cwd = process.cwd();
  const { config: rawCfg } = await loadConfig(opts.config, cwd);
  const cfg = resolveConfig(rawCfg, opts.cwd ?? cwd);
  if (opts.runsDir) cfg.runsDir = opts.runsDir;
  if (opts.webPort !== undefined) cfg.web.port = opts.webPort;
  // The web UI is on by default. `--noweb` turns it off wholesale: port 0
  // skips the HTTP server boot below (and so the browser open too), regardless
  // of any --web-port the user also passed.
  if (opts.noWeb) cfg.web.port = 0;
  if (opts.noOpen) cfg.web.openBrowser = false;

  const wf = await loadWorkflow(opts.workflowPath);

  const inputArgs = await readArgs(opts);

  const runId = uuid();
  const bus = new EventBus();

  // Stdout logger for headless visibility — full machine-readable JSON so
  // pipelines can `| jq`. Stderr gets a human-readable summary at agent.end
  // showing the full assistant text (LLM output), since the JSON-dumped
  // agent.tool.result events tend to dominate the stream and the actual
  // model reply is otherwise easy to miss.
  const labels = new Map<string, string>();
  const reasoningBuf = new Map<string, string>();
  bus.on((ev) => {
    // Skip incremental streaming deltas — same predicate the run-log uses.
    // Stdout would otherwise dump one JSON line per token, drowning the
    // useful per-agent summary printed at agent.end below.
    if (!isIncrementalEvent(ev)) {
      process.stdout.write(JSON.stringify(ev) + "\n");
    }
    if (ev.kind === "agent.start") {
      labels.set(ev.agentId, ev.label ?? ev.agentId.slice(0, 8));
      reasoningBuf.set(ev.agentId, "");
    } else if (ev.kind === "agent.reasoning") {
      reasoningBuf.set(ev.agentId, (reasoningBuf.get(ev.agentId) ?? "") + ev.delta);
    } else if (ev.kind === "agent.end") {
      const tag = labels.get(ev.agentId) ?? ev.agentId.slice(0, 8);
      const status = ev.ok ? "ok" : ev.reason ?? "fail";
      const elapsed = `${(ev.elapsedMs / 1000).toFixed(1)}s`;
      const raw = (ev.rawText ?? "").trim();
      const reasoning = (reasoningBuf.get(ev.agentId) ?? "").trim();
      reasoningBuf.delete(ev.agentId);
      const header = `\n── agent ${tag} [${status}] ${elapsed} ─────────────────────────`;
      const reasoningBlock = reasoning.length > 0
        ? `\n[thinking]\n${reasoning}\n`
        : "";
      process.stderr.write(`${header}${reasoningBlock}\n${raw.length > 0 ? raw : "(no assistant text)"}\n`);
    }
  });

  const store = new RunStore(cfg.runsDir, runId);
  await store.open();
  store.attach(bus);

  // Per-agent XML chat logs sit alongside the run-wide events.ndjson so each
  // agent() call can be reviewed as a single readable conversation (prompt,
  // reasoning, assistant text, tool input + output, retries, final result).
  const agentLogs = new AgentLogStore(cfg.runsDir, runId);
  await agentLogs.open();
  agentLogs.attach(bus);

  await store.writeMeta({
    runId,
    workflowPath: wf.path,
    workflowSha256: wf.sha256,
    workflowName: wf.meta.name,
    workflowDescription: wf.meta.description,
    workflowPhases: wf.meta.phases,
    startedAt: Date.now(),
    args: inputArgs,
    config: cfg,
  });

  // Boot opencode driver + web server.
  const driver = new OpencodeDriver(cfg);
  const ctx = makeRunContext({ runId, bus, driver, config: cfg });
  const agent = makeAgentPrimitive(ctx);
  const phase = makePhasePrimitive(ctx);
  const memory = makeMemoryPrimitive(ctx);
  const log = makeLogPrimitive(ctx);
  const defineTool = makeDefineToolPrimitive(ctx);

  // In-process HTTP server that exposes workflow-registered tools to the
  // sub-agent. Boot first so we know its base URL before any opencode
  // worker is asked to connect to it.
  //
  // Wire path: instead of registering the server as an MCP entry (which
  // would force opencode to prefix every tool as `__runner___<name>`),
  // we install a `pluginPathProvider` on the driver. The first time a
  // worktree boots, the provider generates a tiny opencode plugin file
  // that lists every defineTool()-registered tool under its BARE name
  // and calls back into the same HTTP server's plain-JSON /rpc/call
  // endpoint. That way the model sees `report_file_status`, not
  // `__runner___report_file_status`. See RunnerPluginFile.ts for the
  // rationale.
  let runnerToolServer: RunnerToolServerHandle | null = null;
  runnerToolServer = await startRunnerToolServer(ctx);
  const pluginFilePath = joinPath(cfg.runsDir, runId, "runner-plugin.mjs");
  driver.setPluginPathProvider(async () => {
    const tools = Array.from(ctx.runnerTools.values());
    if (tools.length === 0) return null;
    // Lock the registry here too so any late defineTool() raises the
    // standard "registered after first agent()" warning, even when the
    // very first boot is what triggers plugin-file generation.
    ctx.runnerToolsLocked = true;
    return await writeRunnerPluginFile({
      destPath: pluginFilePath,
      rpcUrl: runnerToolServer!.rpcUrl,
      tools,
    });
  });

  let httpServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  let unregisterRun: (() => void) | null = null;
  if (cfg.web.port > 0) {
    httpServer = await startHttpServer(
      { port: cfg.web.port, runsDir: cfg.runsDir },
      bus,
    );
    // Expose this run's control surface to the WS layer so the UI's
    // per-agent abort/retry and permission.asked approval buttons land on
    // the live agentControls map + the booted OpencodeDriver.
    unregisterRun = httpServer.registerRun(runId, {
      agentControls: ctx.agentControls,
      replyPermission: (requestID, reply) => driver.replyPermission(requestID, reply),
    });
    process.stderr.write(`agent-runner web: ${httpServer.url}/run/${runId}\n`);
    if (cfg.web.openBrowser) {
      void openBrowser(`${httpServer.url}/run/${runId}`);
    }
  }

  bus.emit({
    kind: "workflow.start",
    runId,
    workflowPath: wf.path,
    meta: wf.meta,
    args: inputArgs,
    t: nowMs(),
  });

  // Wire SIGINT / SIGTERM / fatal exit to abort in-flight agents AND tear
  // down the opencode child processes. Without driver.shutdown() here, a
  // killed bun parent leaves orphan opencode.exe processes (cross-spawn'd
  // by the SDK) holding file handles to opencode.db and logs.
  let interrupted = false;
  const teardown = async (sig: string) => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`\nagent-runner: ${sig} — aborting agents + shutting down opencode…\n`);
    for (const ab of ctx.activeAborts) {
      try {
        await ab();
      } catch {
        // best effort
      }
    }
    try {
      await driver.shutdown();
    } catch {
      // best effort
    }
    if (httpServer) {
      try { httpServer.close(); } catch { /* ignore */ }
    }
    try { await store.close(); } catch { /* ignore */ }
    try { await agentLogs.close(); } catch { /* ignore */ }
    if (runnerToolServer) {
      try { await runnerToolServer.close(); } catch { /* ignore */ }
    }
    // 130 is the conventional exit code for SIGINT.
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const onInterrupt = () => { void teardown("SIGINT"); };
  const onTerm      = () => { void teardown("SIGTERM"); };
  // process.on("exit") fires for plain process.exit() too; can't be async
  // there, so we do a best-effort sync shutdown via SIGINT-style teardown
  // earlier in the handler chain. The two signal handlers above are the
  // primary cleanup path.
  process.on("SIGINT",  onInterrupt);
  process.on("SIGTERM", onTerm);

  const res = await runWorkflow(wf, {
    agent: agent as unknown as (prompt: string, opts?: unknown) => Promise<unknown>,
    pipeline: pipelineImpl as unknown as (items: unknown[], ...stages: Array<(...args: unknown[]) => unknown>) => Promise<unknown[]>,
    parallel: parallelImpl as unknown as (thunks: Array<() => unknown>) => Promise<unknown[]>,
    phase,
    memory,
    log,
    defineTool,
    args: inputArgs,
  });

  if (res.ok) {
    bus.emit({
      kind: "workflow.end",
      runId,
      ok: true,
      result: res.result,
      t: nowMs(),
    });
  } else {
    bus.emit({
      kind: "workflow.end",
      runId,
      ok: false,
      error: {
        message: res.error.message,
        stack: res.error.stack,
      },
      t: nowMs(),
    });
    process.stderr.write(`agent-runner: workflow threw: ${res.error.stack ?? res.error.message}\n`);
  }

  await driver.shutdown();
  await store.close();
  await agentLogs.close();
  if (runnerToolServer) {
    try { await runnerToolServer.close(); } catch { /* ignore */ }
  }
  await RunStore.pruneOld(cfg.runsDir, cfg.retention.maxRuns);
  if (httpServer && !cfg.web.openBrowser && cfg.web.port > 0) {
    // Keep server alive for headless inspection only when explicitly requested.
    // Default: close after run so the CLI exits cleanly.
  }
  if (unregisterRun) unregisterRun();
  if (httpServer) httpServer.close();
  process.off("SIGINT",  onInterrupt);
  process.off("SIGTERM", onTerm);

  return res.ok ? 0 : 1;
}

async function readArgs(opts: RunOptions): Promise<unknown> {
  if (opts.argsJson) {
    return Object.freeze(JSON.parse(opts.argsJson));
  }
  if (opts.argsFile) {
    const abs = resolve(process.cwd(), opts.argsFile);
    const txt = await readFile(abs, "utf8");
    return Object.freeze(JSON.parse(txt));
  }
  // Stdin if not a TTY.
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks).toString("utf8").trim();
    if (buf.length === 0) return Object.freeze({});
    try {
      return Object.freeze(JSON.parse(buf));
    } catch {
      return Object.freeze({ raw: buf });
    }
  }
  return Object.freeze({});
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore
  }
}
