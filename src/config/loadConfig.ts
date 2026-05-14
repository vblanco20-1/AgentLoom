import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerConfig } from "./types.ts";

const CANDIDATES = [
  "runner.config.ts",
  "runner.config.js",
  "runner.config.mjs",
  "runner.config.json",
];

export async function loadConfig(
  explicit: string | undefined,
  cwd: string,
): Promise<{ config: RunnerConfig | undefined; path: string | null }> {
  if (explicit) {
    const abs = resolve(cwd, explicit);
    if (!existsSync(abs)) {
      throw new Error(`Config file not found: ${abs}`);
    }
    return { config: await loadOne(abs), path: abs };
  }
  for (const name of CANDIDATES) {
    const abs = resolve(cwd, name);
    if (existsSync(abs)) {
      return { config: await loadOne(abs), path: abs };
    }
  }
  return { config: undefined, path: null };
}

async function loadOne(absPath: string): Promise<RunnerConfig> {
  if (absPath.endsWith(".json")) {
    const txt = await Bun.file(absPath).text();
    return JSON.parse(txt) as RunnerConfig;
  }
  // Bun can import .ts/.js/.mjs directly.
  const mod = (await import(pathToFileURL(absPath).href)) as {
    default?: RunnerConfig;
  };
  if (!mod.default) {
    throw new Error(
      `Config at ${absPath} must export default an object (RunnerConfig).`,
    );
  }
  return mod.default;
}
