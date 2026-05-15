import type { ResolvedRunnerConfig, RunnerConfig } from "./types.ts";

// Default permission policy injected into opencode's config: allow every
// read-like tool unconditionally, including reads of files outside the
// project root (external_directory). Without this, opencode emits a
// `permission.asked` event the runner has no handler for, and the calling
// agent sits in a `pending` tool state until something (SIGINT, timeout)
// tears it down — exactly the failure mode that stranded the stb_image_port
// `audit` agent at run 0832e508 when it tried to read jai6/modules/stb_image/
// bindings.jai. Write-side tools (edit, bash) intentionally inherit
// opencode's defaults; only reads are blanket-allowed.
const DEFAULT_READ_PERMISSIONS: Record<string, "allow"> = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  external_directory: "allow",
};

function resolvePermission(userValue: unknown): unknown {
  // User left it unset → install our read-anywhere defaults.
  if (userValue == null) return { ...DEFAULT_READ_PERMISSIONS };
  // String form ("ask" | "allow" | "deny") is a blanket policy across every
  // tool; honor it verbatim so a deliberate "ask" or "deny" isn't silently
  // overridden by our read-allow defaults.
  if (typeof userValue === "string") return userValue;
  // Object form: layer defaults UNDER the user's per-tool entries so any
  // explicit user setting (including a stricter read policy) wins.
  if (typeof userValue === "object") {
    return { ...DEFAULT_READ_PERMISSIONS, ...(userValue as Record<string, unknown>) };
  }
  return { ...DEFAULT_READ_PERMISSIONS };
}

export function resolveConfig(
  raw: RunnerConfig | undefined,
  cwdOverride: string,
): ResolvedRunnerConfig {
  const r = raw ?? {};
  const userExtra = r.opencode?.extraConfig ?? {};
  return {
    defaultModel: r.defaultModel ?? null,
    defaultAgent: r.defaultAgent ?? null,
    defaultCwd: r.defaultCwd ?? cwdOverride,
    // Hard cap on concurrently-running agents — opencode worker startup
    // is heavy on Windows and 3+ parallel agents tend to thrash the SSE
    // stream. Two is the sweet spot for fan-out without saturating the box.
    maxAgentsTotal: r.maxAgentsTotal ?? 2,
    maxAgentsPerWorktree: r.maxAgentsPerWorktree ?? 2,
    agentTimeoutMs: r.agentTimeoutMs ?? 10 * 60 * 1000,
    maxSchemaRetries: r.maxSchemaRetries ?? 5,
    opencode: {
      binary: r.opencode?.binary ?? "opencode",
      hostname: r.opencode?.hostname ?? "127.0.0.1",
      bootTimeoutMs: r.opencode?.bootTimeoutMs ?? 30_000,
      extraConfig: {
        ...userExtra,
        permission: resolvePermission((userExtra as Record<string, unknown>).permission),
      },
    },
    mcp: r.mcp ?? {},
    web: {
      port: r.web?.port ?? 7777,
      openBrowser: r.web?.openBrowser ?? true,
    },
    runsDir: r.runsDir ?? ".runner/runs",
    retention: {
      maxRuns: r.retention?.maxRuns ?? 200,
    },
  };
}
