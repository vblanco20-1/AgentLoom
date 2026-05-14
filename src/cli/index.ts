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
    // CAC normalises kebab-case option names to camelCase, so read camelCase
    // first and fall back to the dashed form for older CAC versions.
    const getOpt = (camel: string, dashed: string) =>
      (opts[camel] as string | undefined) ?? (opts[dashed] as string | undefined);
    const code = await runCli({
      workflowPath: workflow,
      argsFile: getOpt("argsFile", "args-file"),
      argsJson: getOpt("argsJson", "args-json"),
      config: opts.config as string | undefined,
      webPort: Number(getOpt("webPort", "web-port") ?? 7777),
      noOpen: opts.open === false,
      runsDir: getOpt("runsDir", "runs-dir") ?? ".runner/runs",
      cwd: opts.cwd as string | undefined,
      logLevel: getOpt("logLevel", "log-level") ?? "info",
    });
    process.exit(code);
  });

cli
  .command("web", "Read-only run-history viewer")
  .option("--port <port>", "Listen port", { default: 7777 })
  .option("--runs-dir <path>", "Runs directory", { default: ".runner/runs" })
  .action(async (opts: Record<string, unknown>) => {
    // CAC normalises kebab-case option names to camelCase on `opts`, so
    // `--runs-dir` lands as opts.runsDir, not opts["runs-dir"]. Read both
    // forms to be defensive across CAC versions.
    const runsDir = (opts.runsDir as string | undefined)
      ?? (opts["runs-dir"] as string | undefined)
      ?? ".runner/runs";
    const code = await webCli({
      port: Number(opts.port ?? 7777),
      runsDir,
    });
    process.exit(code);
  });

cli
  .command("replay <runId>", "Replay a past run into a fresh WS room")
  .option("--web-port <port>", "Web UI port", { default: 7777 })
  .option("--runs-dir <path>", "Runs directory", { default: ".runner/runs" })
  .option("--speed <s>", "1x|2x|max", { default: "1x" })
  .action(async (runId: string, opts: Record<string, unknown>) => {
    const get = (camel: string, dashed: string) =>
      (opts[camel] as string | undefined) ?? (opts[dashed] as string | undefined);
    const code = await replayCli({
      runId,
      webPort: Number(get("webPort", "web-port") ?? 7777),
      runsDir: get("runsDir", "runs-dir") ?? ".runner/runs",
      speed: (opts.speed as string | undefined) ?? "1x",
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
