import { mkdir, writeFile, appendFile, readdir, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { EventBus } from "../bus/EventBus.ts";
import type { RunnerEvent } from "../bus/events.ts";

const FLUSH_INTERVAL_MS = 100;
const FLUSH_BYTES = 4 * 1024;
const FLUSH_EVENTS = 64;

export class RunStore {
  private dir: string;
  private eventsPath: string;
  private metaPath: string;
  private resultPath: string;
  private buf: string[] = [];
  private bufBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private closed = false;

  constructor(rootDir: string, runId: string) {
    this.dir = resolve(rootDir, runId);
    this.eventsPath = join(this.dir, "events.ndjson");
    this.metaPath = join(this.dir, "meta.json");
    this.resultPath = join(this.dir, "result.json");
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.eventsPath, "", { flag: "wx" }).catch(() => {/* exists */});
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  attach(bus: EventBus): void {
    this.unsub = bus.on((ev) => this.write(ev));
  }

  private write(ev: RunnerEvent): void {
    if (this.closed) return;
    const line = JSON.stringify(ev) + "\n";
    this.buf.push(line);
    this.bufBytes += line.length;
    if (ev.kind === "workflow.end") {
      void this.onWorkflowEnd(ev);
    } else if (this.buf.length >= FLUSH_EVENTS || this.bufBytes >= FLUSH_BYTES) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join("");
    this.buf = [];
    this.bufBytes = 0;
    try {
      await appendFile(this.eventsPath, chunk);
    } catch {
      // best-effort
    }
  }

  private async onWorkflowEnd(ev: Extract<RunnerEvent, { kind: "workflow.end" }>): Promise<void> {
    await this.flush();
    try {
      await writeFile(this.resultPath, JSON.stringify({ ok: ev.ok, result: ev.result, error: ev.error }, null, 2));
    } catch {/* ignore */}
  }

  async writeMeta(meta: unknown): Promise<void> {
    await writeFile(this.metaPath, JSON.stringify(meta, null, 2));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.unsub) this.unsub();
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }

  static async pruneOld(rootDir: string, maxRuns: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch {
      return;
    }
    const stamped = await Promise.all(
      entries.map(async (name) => {
        try {
          const s = await stat(join(rootDir, name));
          return { name, mtime: s.mtimeMs, isDir: s.isDirectory() };
        } catch {
          return null;
        }
      }),
    );
    const dirs = stamped.filter((s): s is { name: string; mtime: number; isDir: boolean } => !!s && s.isDir);
    if (dirs.length <= maxRuns) return;
    dirs.sort((a, b) => a.mtime - b.mtime);
    const toRemove = dirs.length - maxRuns;
    for (let i = 0; i < toRemove; i++) {
      try {
        await rm(join(rootDir, dirs[i]!.name), { recursive: true, force: true });
      } catch {/* ignore */}
    }
  }
}
