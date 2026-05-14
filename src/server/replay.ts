import { open } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerEvent } from "../bus/events.ts";

export async function readEventsFile(path: string): Promise<RunnerEvent[]> {
  const fh = await open(path, "r");
  try {
    const data = await fh.readFile({ encoding: "utf8" });
    return data
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as RunnerEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is RunnerEvent => e !== null);
  } finally {
    await fh.close();
  }
}

export interface ReplayOptions {
  speed: number; // 1 = real time, 2 = 2x, Infinity = max
  onEvent: (ev: RunnerEvent) => void;
  signal?: AbortSignal;
}

export async function replayRun(eventsPath: string, opts: ReplayOptions): Promise<void> {
  const evs = await readEventsFile(eventsPath);
  if (evs.length === 0) return;
  const t0 = evs[0]!.t;
  const start = Date.now();
  for (const ev of evs) {
    if (opts.signal?.aborted) return;
    if (Number.isFinite(opts.speed)) {
      const targetOffset = (ev.t - t0) / opts.speed;
      const elapsed = Date.now() - start;
      const wait = targetOffset - elapsed;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    opts.onEvent(ev);
  }
}

export function defaultEventsPath(runsDir: string, runId: string): string {
  return join(runsDir, runId, "events.ndjson");
}
