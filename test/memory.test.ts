import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryPrefix,
  ensureMemoryFile,
  resolveMemoryPath,
} from "../src/util/memoryFile.ts";
import { makeMemoryPrimitive } from "../src/primitives/memory.ts";
import { makeAgentPrimitive } from "../src/primitives/agent.ts";
import { EventBus } from "../src/bus/EventBus.ts";
import { pLimit } from "../src/util/pLimit.ts";
import type { OpencodeDriver } from "../src/driver/OpencodeDriver.ts";
import type { RunContext } from "../src/primitives/runtime.ts";
import type { PromptHandle, PromptRequest } from "../src/driver/promptRunner.ts";
import type { ResolvedRunnerConfig } from "../src/config/types.ts";
import type { RunnerEvent } from "../src/bus/events.ts";

function makeStubCtx(cwd: string) {
  const bus = new EventBus();
  const events: RunnerEvent[] = [];
  bus.on((e) => events.push(e));

  // Capture every PromptRequest the agent primitive hands to the driver.
  const calls: PromptRequest[] = [];
  const driver = {
    run: async (_cwd: string, req: PromptRequest): Promise<PromptHandle> => {
      calls.push(req);
      return {
        abort: async () => {},
        result: Promise.resolve({
          ok: true,
          data: { stub: true },
          rawText: '{"stub":true}',
          elapsedMs: 1,
        }),
      };
    },
  } as unknown as OpencodeDriver;

  const config: ResolvedRunnerConfig = {
    defaultModel: null,
    defaultAgent: null,
    defaultCwd: cwd,
    maxAgentsTotal: 4,
    maxAgentsPerWorktree: 2,
    agentTimeoutMs: 10_000,
    maxSchemaRetries: 0,
    opencode: { binary: "opencode", hostname: "127.0.0.1", bootTimeoutMs: 30_000, extraConfig: {} },
    mcp: {},
    web: { port: 0, openBrowser: false },
    runsDir: ".runner/runs",
    retention: { maxRuns: 200 },
  };

  const ctx: RunContext = {
    runId: "test-run",
    bus,
    driver,
    config,
    agentPool: pLimit(4),
    perWorktreePool: new Map(),
    activeAborts: new Set(),
    agentControls: new Map(),
    activeMemory: null,
    runnerTools: new Map(),
    runnerToolsLocked: false,
  };

  return { ctx, bus, events, calls };
}

describe("memoryFile helpers", () => {
  it("resolves absolute paths as-is and relative against cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memfile-"));
    const abs = join(dir, "abs.md");
    expect(resolveMemoryPath(abs, "/somewhere/else")).toBe(abs);
    expect(resolveMemoryPath("notes.md", dir)).toBe(join(dir, "notes.md"));
  });

  it("creates the file (and parent dirs) without truncating existing content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memfile-"));
    const target = join(dir, "nested", "deeper", "notes.md");
    await ensureMemoryFile(target);
    const s1 = await stat(target);
    expect(s1.isFile()).toBe(true);
    expect(s1.size).toBe(0);

    await writeFile(target, "prior content\n", "utf8");
    await ensureMemoryFile(target); // must not wipe
    const after = await readFile(target, "utf8");
    expect(after).toBe("prior content\n");
  });

  it("builds a memory prefix that names the file and prescribes append-only", () => {
    const prefix = buildMemoryPrefix("/tmp/notes.md");
    expect(prefix).toContain("/tmp/notes.md");
    expect(prefix).toContain("SHARED MEMORY");
    expect(prefix).toContain("APPEND");
    expect(prefix).toContain("NEVER overwrite");
  });
});

describe("memory primitive", () => {
  it("sets, clears, and emits memory.set events on transitions only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const { ctx, events } = makeStubCtx(dir);
    const memory = makeMemoryPrimitive(ctx);

    expect(memory("notes.md")).toBe("notes.md");
    expect(ctx.activeMemory).toBe("notes.md");

    // Re-setting the same path is a no-op for event emission.
    memory("notes.md");
    const memEvents1 = events.filter((e) => e.kind === "memory.set");
    expect(memEvents1.length).toBe(1);

    memory(null);
    expect(ctx.activeMemory).toBeNull();
    const memEvents2 = events.filter((e) => e.kind === "memory.set");
    expect(memEvents2.length).toBe(2);
    expect((memEvents2[1] as { path: string | null }).path).toBeNull();
  });
});

describe("agent() memory integration", () => {
  it("injects the memory prefix and reports memoryPath on agent.start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const { ctx, events, calls } = makeStubCtx(dir);
    const memory = makeMemoryPrimitive(ctx);
    const agent = makeAgentPrimitive(ctx);

    memory("notes.md");
    await agent("do the task", { label: "t1" });

    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toContain("SHARED MEMORY");
    expect(calls[0].prompt).toContain(join(dir, "notes.md"));
    expect(calls[0].prompt).toContain("do the task");

    const start = events.find((e) => e.kind === "agent.start") as
      | { memoryPath?: string; prompt: string }
      | undefined;
    expect(start?.memoryPath).toBe(join(dir, "notes.md"));
    // The event records the original prompt without the prefix so the UI
    // shows what the workflow asked, not the runner's framing.
    expect(start?.prompt).toBe("do the task");

    // File was created up-front.
    const s = await stat(join(dir, "notes.md"));
    expect(s.isFile()).toBe(true);
  });

  it("per-call { memory: 'alt.md' } overrides the active binding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const { ctx, calls } = makeStubCtx(dir);
    const memory = makeMemoryPrimitive(ctx);
    const agent = makeAgentPrimitive(ctx);

    memory("base.md");
    await agent("p", { label: "ovr", memory: "alt.md" });
    expect(calls[0].prompt).toContain(join(dir, "alt.md"));
    expect(calls[0].prompt).not.toContain(join(dir, "base.md"));
  });

  it("per-call { memory: false } disables memory for one call only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const { ctx, calls } = makeStubCtx(dir);
    const memory = makeMemoryPrimitive(ctx);
    const agent = makeAgentPrimitive(ctx);

    memory("base.md");
    await agent("p1", { label: "off", memory: false });
    await agent("p2", { label: "on" });

    expect(calls[0].prompt).not.toContain("SHARED MEMORY");
    expect(calls[1].prompt).toContain("SHARED MEMORY");
    expect(calls[1].prompt).toContain(join(dir, "base.md"));
  });

  it("no memory binding → prompt passes through unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const { ctx, calls } = makeStubCtx(dir);
    const agent = makeAgentPrimitive(ctx);

    await agent("plain prompt", { label: "plain" });
    expect(calls[0].prompt).toBe("plain prompt");
  });
});
