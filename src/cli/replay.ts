import { EventBus } from "../bus/EventBus.ts";
import { startHttpServer } from "../server/http.ts";
import { defaultEventsPath, replayRun } from "../server/replay.ts";
import { uuid } from "../util/uuid.ts";

export interface ReplayOptions {
  runId: string;
  webPort: number;
  runsDir: string;
  speed: string;
}

export async function replayCli(opts: ReplayOptions): Promise<number> {
  const bus = new EventBus();
  const server = await startHttpServer({ port: opts.webPort, runsDir: opts.runsDir }, bus);
  const newRunId = uuid();
  process.stderr.write(`agent-runner replay: ${server.url}/run/${newRunId}\n`);
  const speed = opts.speed === "max" ? Infinity : opts.speed === "2x" ? 2 : 1;
  await replayRun(defaultEventsPath(opts.runsDir, opts.runId), {
    speed,
    onEvent: (ev) => bus.emit({ ...ev, runId: newRunId }),
  });
  process.stderr.write("agent-runner replay: complete\n");
  await new Promise(() => {});
  return 0;
}
