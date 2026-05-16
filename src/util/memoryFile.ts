import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

// Resolve a workflow-supplied memory path against an agent's cwd.
// Absolute paths pass through; relative paths anchor at cwd so the model's
// file tools (which run in that cwd) can read/append it directly.
export function resolveMemoryPath(memoryPath: string, cwd: string): string {
  return isAbsolute(memoryPath) ? memoryPath : resolve(cwd, memoryPath);
}

// Create the memory file if it doesn't exist yet, including any parent
// directories. Uses O_APPEND so an existing file is never truncated — prior
// agents' notes survive. Best-effort: errors are swallowed because a missing
// file just means the agent's first read sees "" (and the runner still
// instructs it to append).
export async function ensureMemoryFile(absPath: string): Promise<void> {
  try {
    await mkdir(dirname(absPath), { recursive: true });
    const fh = await open(absPath, "a");
    await fh.close();
  } catch {
    // best effort
  }
}

// Prompt prefix injected ahead of the agent's task (and the schema block).
// The agent has full Read/Write/Edit tools and can drive the file itself —
// the runner only points it at the file and prescribes the protocol.
export function buildMemoryPrefix(absPath: string): string {
  return [
    "──────────────────────── SHARED MEMORY ────────────────────────",
    `A shared notes file lives at: ${absPath}`,
    "",
    "BEFORE doing your task:",
    `  1. Read ${absPath} to see what prior agents already discovered,`,
    "     attempted, decided, or warned about.",
    "  2. Do NOT repeat work or re-derive conclusions already captured there.",
    "",
    "AFTER completing your task:",
    "  3. APPEND a concise entry (a few lines max) summarising your findings,",
    "     decisions, or warnings — anything the next agent would benefit from.",
    "  4. Prefix each entry with a short tag so others can scan, e.g.:",
    "        [impl:foo.rs] used Cow<str> for the lookup; see line 42",
    "        [verify:foo.rs] confirmed; no regressions in suite X",
    "  5. NEVER overwrite or delete prior entries. Append-only.",
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}
