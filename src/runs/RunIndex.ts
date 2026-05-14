import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RunIndexEntry {
  runId: string;
  meta: {
    workflowPath?: string;
    workflowName?: string;
    workflowDescription?: string;
    startedAt?: number;
  };
  result: {
    ok?: boolean;
    error?: { message: string };
  } | null;
  hasEvents: boolean;
  mtimeMs: number;
}

export class RunIndex {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async list(): Promise<RunIndexEntry[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const out: RunIndexEntry[] = [];
    for (const name of entries) {
      const dir = join(this.rootDir, name);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
        const metaPath = join(dir, "meta.json");
        const resultPath = join(dir, "result.json");
        const eventsPath = join(dir, "events.ndjson");
        let meta: RunIndexEntry["meta"] = {};
        let result: RunIndexEntry["result"] = null;
        let hasEvents = false;
        try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch {/* ignore */}
        try { result = JSON.parse(await readFile(resultPath, "utf8")); } catch {/* ignore */}
        try { const es = await stat(eventsPath); hasEvents = es.size > 0; } catch {/* ignore */}
        out.push({ runId: name, meta, result, hasEvents, mtimeMs: s.mtimeMs });
      } catch {
        continue;
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  eventsPath(runId: string): string {
    return join(this.rootDir, runId, "events.ndjson");
  }

  metaPath(runId: string): string {
    return join(this.rootDir, runId, "meta.json");
  }

  resultPath(runId: string): string {
    return join(this.rootDir, runId, "result.json");
  }

  rootPath(): string {
    return this.rootDir;
  }
}
