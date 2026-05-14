import { cac } from "cac";
import { runCli } from "./run.ts";
import { webCli } from "./web.ts";
import { replayCli } from "./replay.ts";

const cli = cac("agent-runner");

cli
  .command("run <workflow>", "Execute a workflow file")
  .option("--args-file <path>", "JSON file used as `args`")
  .option("--args-json <json>", "Inline JSON for `args` (overrides --args-file)")
  .option("--config <path>", "Path to runner.config.{ts,js,json}")
  .option("--web-port <port>", "Web UI port (0 to disable)", { default: 7777 })
  .option("--no-open", "Do not open browser")
  .option("--runs-dir <path>", "Where to write NDJSON event logs", { default: ".runner/runs" })
  .option("--cwd <path>", "Default cwd for agents lacking opts.cwd")
  .option("--log-level <l>", "trace|debug|info|warn|error", { default: "info" })
  .action(async (workflow: string, opts: Record<string, unknown>) => {
    const code = await runCli({
      workflowPath: workflow,
      argsFile: opts["args-file"] as string | undefined,
      argsJson: opts["args-json"] as string | undefined,
      config: opts.config as string | undefined,
      webPort: Number(opts["web-port"]),
      noOpen: opts.open === false,
      runsDir: opts["runs-dir"] as string,
      cwd: opts.cwd as string | undefined,
      logLevel: opts["log-level"] as string,
    });
    process.exit(code);
  });

cli
  .command("web", "Read-only run-history viewer")
  .option("--port <port>", "Listen port", { default: 7777 })
  .option("--runs-dir <path>", "Runs directory", { default: ".runner/runs" })
  .action(async (opts: Record<string, unknown>) => {
    const code = await webCli({
      port: Number(opts.port),
      runsDir: opts["runs-dir"] as string,
    });
    process.exit(code);
  });

cli
  .command("replay <runId>", "Replay a past run into a fresh WS room")
  .option("--web-port <port>", "Web UI port", { default: 7777 })
  .option("--runs-dir <path>", "Runs directory", { default: ".runner/runs" })
  .option("--speed <s>", "1x|2x|max", { default: "1x" })
  .action(async (runId: string, opts: Record<string, unknown>) => {
    const code = await replayCli({
      runId,
      webPort: Number(opts["web-port"]),
      runsDir: opts["runs-dir"] as string,
      speed: opts.speed as string,
    });
    process.exit(code);
  });

cli.help();
cli.version("0.1.0");

const parsed = cli.parse(process.argv, { run: false });
const matched = (cli as unknown as { matchedCommand?: unknown }).matchedCommand;
if (parsed.options.help || !matched) {
  cli.outputHelp();
  process.exit(0);
} else {
  try {
    await cli.runMatchedCommand();
  } catch (err) {
    process.stderr.write(`agent-runner: ${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(2);
  }
}
