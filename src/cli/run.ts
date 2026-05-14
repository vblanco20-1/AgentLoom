import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/loadConfig.ts";
import { resolveConfig } from "../config/defaults.ts";
import { loadWorkflow, runWorkflow } from "../workflow/vm.ts";
import { EventBus } from "../bus/EventBus.ts";
import { OpencodeDriver } from "../driver/OpencodeDriver.ts";
import { makeRunContext } from "../primitives/runtime.ts";
import { makeAgentPrimitive } from "../primitives/agent.ts";
import { pipelineImpl } from "../primitives/pipeline.ts";
import { parallelImpl } from "../primitives/parallel.ts";
import { makePhasePrimitive } from "../primitives/phase.ts";
import { makeLogPrimitive } from "../primitives/log.ts";
import { RunStore } from "../runs/RunStore.ts";
import { startHttpServer } from "../server/http.ts";
import { uuid } from "../util/uuid.ts";
import { nowMs } from "../bus/events.ts";

export interface RunOptions {
  workflowPath: string;
  argsFile?: string;
  argsJson?: string;
  config?: string;
  webPort?: number;
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
  if (opts.noOpen) cfg.web.openBrowser = false;

  const wf = await loadWorkflow(opts.workflowPath);

  const inputArgs = await readArgs(opts);

  const runId = uuid();
  const bus = new EventBus();

  // Stdout logger for headless visibility.
  bus.on((ev) => {
    process.stdout.write(JSON.stringify(ev) + "\n");
  });

  const store = new RunStore(cfg.runsDir, runId);
  await store.open();
  store.attach(bus);
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
  const log = makeLogPrimitive(ctx);

  let httpServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  if (cfg.web.port > 0) {
    httpServer = await startHttpServer(
      { port: cfg.web.port, runsDir: cfg.runsDir },
      bus,
    );
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

  // Wire SIGINT to abort all in-flight agents + shutdown.
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write("\nagent-runner: SIGINT — aborting in-flight agents…\n");
    for (const ab of ctx.activeAborts) void ab();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const res = await runWorkflow(wf, {
    agent: agent as unknown as (prompt: string, opts?: unknown) => Promise<unknown>,
    pipeline: pipelineImpl as unknown as (items: unknown[], ...stages: Array<(...args: unknown[]) => unknown>) => Promise<unknown[]>,
    parallel: parallelImpl as unknown as (thunks: Array<() => unknown>) => Promise<unknown[]>,
    phase,
    log,
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
  await RunStore.pruneOld(cfg.runsDir, cfg.retention.maxRuns);
  if (httpServer && !cfg.web.openBrowser && cfg.web.port > 0) {
    // Keep server alive for headless inspection only when explicitly requested.
    // Default: close after run so the CLI exits cleanly.
  }
  if (httpServer) httpServer.close();
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);

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
