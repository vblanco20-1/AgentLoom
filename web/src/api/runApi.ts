import type { RunIndexEntry } from "./types";

export async function fetchRuns(): Promise<RunIndexEntry[]> {
  const r = await fetch("/api/runs");
  if (!r.ok) return [];
  return (await r.json()) as RunIndexEntry[];
}
