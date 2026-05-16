# agent-runner manual

A complete reference for the `agent-runner` v0.1 runtime. This document is the
authoritative user-facing guide; the [README](../README.md) is the elevator
pitch, [IMPLEMENTATION_STATUS](../IMPLEMENTATION_STATUS.md) is the milestone
state, and this is what you read to actually use the thing.

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [Installation](#2-installation)
3. [Quick start](#3-quick-start)
4. [Core concepts](#4-core-concepts)
5. [Workflow API reference](#5-workflow-api-reference)
   - 5.1 [`meta` export](#51-meta-export)
   - 5.2 [`agent(prompt, opts)`](#52-agentprompt-opts)
   - 5.3 [`pipeline(items, ...stages)`](#53-pipelineitems-stages)
   - 5.4 [`parallel(thunks)`](#54-parallelthunks)
   - 5.5 [`phase(title)`](#55-phasetitle)
   - 5.6 [`memory(path)`](#56-memorypath)
   - 5.7 [`log(msg, meta?)`](#57-logmsg-meta)
   - 5.8 [`args`](#58-args)
   - 5.9 [JSON Schema conventions](#59-json-schema-conventions)
6. [CLI reference](#6-cli-reference)
7. [Configuration](#7-configuration)
8. [Web UI](#8-web-ui)
9. [Persistence and replay](#9-persistence-and-replay)
10. [Architecture](#10-architecture)
11. [Operating the runner](#11-operating-the-runner)
12. [Troubleshooting](#12-troubleshooting)
13. [Extending](#13-extending)
14. [Security model](#14-security-model)
15. [Glossary](#15-glossary)

---

## 1. What this is

`agent-runner` is a self-hostable multi-agent workflow runner. You write a
`*.workflow.js` script that fans out work to N sub-agents in parallel,
collects their schema-validated JSON outputs, and returns a final result.
Each sub-agent is a real Claude Code-equivalent agent provided by
[opencode](https://opencode.ai) — it has `Read`, `Edit`, `Write`, `Bash`,
`Grep`, etc.

The API surface is identical to the (undocumented, internal) JavaScript
orchestrator used to port the Bun JavaScript runtime from Zig to Rust. Seven
globals are injected into every workflow:

| Global | Purpose |
|---|---|
| `agent(prompt, opts)` | Spawn one sub-agent. Resolves to validated JSON or `null`. |
| `pipeline(items, ...stages)` | Per-item streaming pipeline. |
| `parallel(thunks)` | Concurrent fan-out. |
| `phase(title)` | Telemetry marker. |
| `memory(path)` | Bind a shared notes file that subsequent agents read + append. |
| `log(msg, meta?)` | Log line. |
| `args` | Frozen input object. |

Workflows use top-level `await`, top-level `return`, and `export const meta`
— the runner unwraps them into an `AsyncFunction` so the script can run as a
regular ESM module *or* an inline orchestration program.

While it runs, a web UI at `http://localhost:7777/run/<id>` streams every
agent's tokens and tool calls in real time. Everything is persisted as NDJSON
to `.runner/runs/<id>/events.ndjson` and is replayable.

---

## 2. Installation

### Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Bun** | ≥ 1.3 | Runtime + bundler + test runner. |
| **Node.js** | ≥ 20 (optional) | Only needed if your IDE's TypeScript tooling expects it. |
| **opencode** | 1.14+ | Provides the agent backend. `npm i -g opencode` or follow opencode docs. |
| A provider API key | — | Whatever opencode is configured for (Anthropic / DeepSeek / OpenAI / etc.). |

Verify with `bun --version` and `opencode --version`.

### Setup

```bash
cd agent_runner
bun install
bun run build:web      # one-time: compile the React UI to web/dist
bun run build          # one-time: compile the CLI to dist/cli/index.js
```

You now have two equivalent ways to launch the runner:

```bash
# 1. From source (recommended during development)
bun bin/agent-runner run <workflow.js>

# 2. Compiled single-file binary (zero deps, ~117 MB)
bun run build:compile
./dist/agent-runner run <workflow.js>      # Linux / Mac
.\dist\agent-runner.exe run <workflow.js>  # Windows
```

### Authenticating opencode

The runner spawns opencode in-process, so it inherits your shell's
environment. Set whatever variable your provider needs:

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# DeepSeek
export DEEPSEEK_API_KEY=...

# OpenAI
export OPENAI_API_KEY=...
```

If you've previously used `opencode auth login`, those credentials are
picked up automatically from opencode's config.

---

## 3. Quick start

Create `hello.workflow.js`:

```js
export const meta = {
  name: "hello",
  description: "Single-agent sanity check",
  phases: [{ title: "Probe" }],
};

phase("Probe");
const out = await agent('Reply with the exact string "OK" and nothing else.', {
  label: "probe",
  phase: "Probe",
});
return { ok: out !== null, text: out };
```

Run it:

```bash
bun bin/agent-runner run hello.workflow.js
```

Expect:
- Browser tab opens to `http://localhost:7777/run/<id>`.
- One agent card appears, streams `OK`, turns green.
- Process exits 0; final `{ ok: true, text: "OK" }` is written to
  `.runner/runs/<id>/result.json`.

To pass input:

```bash
echo '{"name":"Boss"}' | bun bin/agent-runner run hello.workflow.js
# or
bun bin/agent-runner run hello.workflow.js --args-json '{"name":"Boss"}'
# or
bun bin/agent-runner run hello.workflow.js --args-file ./input.json
```

Inside the workflow, `args` is `Object.freeze({ name: "Boss" })`.

---

## 4. Core concepts

### Workflow file

A `.workflow.js` (or `.ts`) is a single ESM module with:
- An `export const meta = { name, description?, phases? }` declaration.
- Free use of top-level `await`, top-level `return`, and top-level `if`/`return`.
- No `import` / `require` — the six globals are injected for you. (You can
  use built-in JS functions like `JSON`, `Math`, `Promise`, `Array.from`,
  etc. The Bun corpus uses lots of these and they all work.)

The runner extracts `meta` via a Babel parse, then wraps the rest of the
source in `new AsyncFunction("agent", "pipeline", "parallel", "phase", "log",
"args", source)` and invokes it. Line numbers are preserved 1:1 — a thrown
error on line 12 of your source shows up as line 12 in the stack trace, not
line 13 of `<anonymous>`.

### Sub-agents

Each `agent()` call spawns one opencode session in the configured cwd, with
the configured model and agent profile. Sub-agents get the full Claude Code
tool surface (Read, Edit, Write, Bash, Grep, Glob, WebSearch, etc.) and may
spend tens of minutes per call running compiles, edits, or analyses. The
runner streams their tokens and tool calls live; you watch progress on the
web UI or in the NDJSON.

### Event bus

Every workflow primitive emits typed events on a shared `EventBus`:
`workflow.start`, `phase.mark`, `agent.start`, `agent.token`,
`agent.tool.start`, `agent.tool.result`, `agent.end`, `workflow.log`,
`workflow.end`. The bus has three consumers by default:

1. **stdout** — each event is JSON-stringified and printed (`bin/agent-runner
   run ... 2>/dev/null | jq` gives you a clean event stream).
2. **NDJSON** — `RunStore` appends every event to
   `.runner/runs/<id>/events.ndjson`, buffered (≤ 4 KB or ≤ 64 events or ≤ 100 ms).
3. **WebSocket** — `WsHub` fan-outs to any connected web client subscribed
   to that runId.

You can add more consumers by calling `bus.on(fn)` if you're embedding the
runner. See [§13 Extending](#13-extending).

### Cwd as the unit of isolation

opencode is **cwd-global**: one server process serves exactly one working
directory. The runner therefore maintains `Map<cwd, WorktreeServer>` and
lazily boots one opencode server per unique `cwd` passed via `agent({
cwd })`. This lets you run agents in parallel against different
worktrees without their builds colliding.

If every agent uses the same default cwd, the runner only boots one
opencode server for the whole run.

---

## 5. Workflow API reference

### 5.1 `meta` export

Required. Declares the workflow's identity.

```js
export const meta = {
  name: "phase-a-port",                   // required, non-empty string
  description: "Port one batch of files", // optional
  phases: [                                // optional, used by the UI timeline
    { title: "Implement" },
    { title: "Verify", detail: "2-vote" },
    { title: "Fix" },
  ],
};
```

- `name` shows up in the run list and as the page title.
- `description` appears under the name.
- `phases` populates the timeline strip; each entry should match the
  `phase: "..."` tag you pass to `agent()` for that stage. Strict
  matching is not enforced — extra/missing tags are tolerated and just
  affect the UI count.

The runner reads `meta` via static AST extraction before executing the
workflow, so its initialiser must be a literal object — you cannot
compute `meta.name` from runtime values.

### 5.2 `agent(prompt, opts)`

Spawn one sub-agent. Returns `Promise<unknown>`:
- If `opts.schema` is set: the parsed-and-validated JSON output, or `null`
  on any failure.
- If `opts.schema` is omitted: the trimmed raw assistant text.

#### Invariants

- **Never throws.** All failures (HTTP error, opencode boot fail, schema
  mismatch, timeout, abort, SSE drop) resolve to `null`. Authors handle
  the null themselves.
- **No auto-retry.** The Bun corpus uses outer `for (let r = 1; r <=
  MAX_ROUNDS; r++)` loops to retry. Match that pattern.
- **No auto-reprompt** on schema fail — invalid JSON → `null`.
- Concurrency is bounded twice: the global `agentPool` (default 8) and the
  per-cwd `perWorktreePool` (default 3). Acquire-order is global → per-cwd
  to avoid deadlock.

#### Options

| Field | Type | Default | Use |
|---|---|---|---|
| `label` | `string` | — | Identifier shown on the UI card and in logs. Convention: `verb:scope`, e.g. `"verify:bun_string/parser"`. |
| `phase` | `string` | — | Phase tag; should match a `meta.phases[].title`. |
| `schema` | JSON Schema | — | Validates the agent's output. See [§5.9](#59-json-schema-conventions). |
| `model` | `{ providerID, modelID }` | `config.defaultModel` | Override the model for this call. |
| `agent` | `string` | `config.defaultAgent` | opencode agent profile name (`build`, `general`, etc.). |
| `tools` | `Record<string, boolean>` | — | Per-call tool allowlist (`{ read: true, edit: false, bash: false }`). Omit for the agent profile's default surface. |
| `cwd` | `string` | `config.defaultCwd` | Working directory. New cwds boot a new opencode server. |
| `timeoutMs` | `number` | `config.agentTimeoutMs` | Per-call deadline; on timeout the session is aborted and `null` returned. |
| `memory` | `string \| false` | inherits `memory()` | Per-call shared-memory override. String = use this path; `false` = disable for this call. See [§5.6](#56-memorypath). |

#### Failure reasons

When `agent()` returns `null`, the corresponding `agent.end` event
includes `reason`:

| `reason` | Meaning |
|---|---|
| `schema` | Output didn't validate against the schema. |
| `abort` | The session was aborted (web UI button or SIGINT). |
| `http` | `POST /session` or `POST /session/:id/prompt_async` failed. |
| `timeout` | `timeoutMs` elapsed before idle. |
| `idle` | Session ended in a non-idle state without a recognised error. |
| `internal` | Unexpected exception in the runner; should never happen. |

`agent.end` events with `ok: true` always carry `reason: "idle"` and the
parsed `output`.

#### Examples

Plain text return:

```js
const text = await agent("Summarise the contents of ./README.md.");
// text is a string, or null
```

Schema-validated:

```js
const IMPL = {
  type: "object",
  required: ["path", "todos"],
  properties: {
    path: { type: "string", description: "absolute path of the file" },
    todos: { type: "integer" },
    skipped: { type: "boolean" },
  },
};

const r = await agent(`Implement foo.rs. Honour PORTING.md.`, {
  label: "impl:foo.rs",
  phase: "Implement",
  schema: IMPL,
  cwd: "/repo/worktrees/branch-a",
  tools: { read: true, edit: true, write: true, bash: true, grep: true },
  timeoutMs: 15 * 60_000,
});
if (!r) {
  // schema fail, abort, timeout, etc.
}
```

2-vote adversarial pattern (canonical in the Bun corpus):

```js
const [a, b] = await parallel(
  [0, 1].map(i => () =>
    agent(verifyPrompt(file), {
      label: `verify[${i}]:${file}`,
      phase: "Verify",
      schema: VERIFY_SCHEMA,
    }),
  ),
);
const aOk = !!a && a.ok;
const bOk = !!b && b.ok;
const consensus = aOk && bOk;
```

### 5.3 `pipeline(items, ...stages)`

Per-item streaming pipeline. Each stage is `(prev, originalItem, idx) =>
next | Promise<next>`. Items progress through stages **independently** —
item N can be in stage 2 while item M is still in stage 1. There is no
barrier between stages.

```js
const results = await pipeline(
  FILES,                                            // items[]
  // stage 1: implement
  f => agent(`Port ${f.name}`, { label: `impl:${f.name}`, phase: "Implement", schema: IMPL_SCHEMA }),
  // stage 2: verify (defensive null)
  (impl, f) => {
    if (!impl) return { ok: false, file: f.name, _skip: true };
    return parallel([0, 1].map(i => () =>
      agent(`Verify ${f.name}`, { label: `verify[${i}]:${f.name}`, phase: "Verify", schema: VERIFY_SCHEMA }),
    )).then(votes => ({ ok: true, file: f.name, impl, votes }));
  },
  // stage 3: fix
  (ver, f) => {
    if (!ver || ver._skip) return { file: f.name, status: "skipped" };
    return agent(`Apply verifier findings to ${f.name}`, { label: `fix:${f.name}`, phase: "Fix", schema: IMPL_SCHEMA })
      .then(fix => ({ file: f.name, status: fix ? "fixed" : "fix-null" }));
  },
);
```

- Stages can return any value (raw object, `Promise`, `null`, another
  awaited thing). The runner `await`s as needed.
- Items make progress as soon as a slot frees in the `agentPool` / per-cwd
  pool — concurrency is not pipeline-level, it's `agent()`-level.
- Stages cannot short-circuit the pipeline for *other* items; use
  workflow-local skip flags (`_skip: true`, `status: "impl-failed"`) and
  pass them through.
- The result is always an `unknown[]` in input order.

#### Sequential variant

Sometimes you need strict serialisation (e.g. a single build directory
shared across items). The Bun corpus pattern is to write a custom
sequential runner:

```js
const sequential = async (items, ...stages) => {
  const out = [];
  for (const it of items) {
    let v = it;
    for (const [i, s] of stages.entries()) v = await s(v, it, i);
    out.push(v);
  }
  return out;
};

const runner = NEEDS_SERIAL ? sequential : pipeline;
const results = await runner(FILES, stage1, stage2, stage3);
```

### 5.4 `parallel(thunks)`

`Promise.all(thunks.map(t => t()))`. The **thunk-not-promise** convention
is universal in the Bun corpus and is required here too — it lets the
runner control *when* each task starts (the `agent()` concurrency cap
gates them).

```js
// CORRECT
const results = await parallel(
  files.map(f => () => agent(`work on ${f}`, { label: f })),
);

// WRONG — starts all calls immediately, bypassing the pool
const results = await parallel(
  files.map(f => agent(`work on ${f}`, { label: f })),  // missing `() =>`
);
```

Results are returned in input order. `parallel` does not impose its own
concurrency limit beyond what `agent()` provides; if your thunks don't
call `agent()`, they all run at once.

### 5.5 `phase(title)`

A pure side-effecting telemetry marker — emits a `phase.mark` event on
the bus and highlights the corresponding pill in the UI's
`PhaseTimeline`. No return value, no side effect on `agent()` calls.

```js
phase("Survey");
const errors = await agent(/* … */);
phase("Fix");
const fixes = await pipeline(/* … */);
```

`phase()` and the `phase: "..."` agent option are **independent** — you
can use either, both, or neither. Both feed the same logical-phase
aggregation in the UI.

### 5.6 `memory(path)`

Bind a shared "scratchpad" file that every subsequent `agent()` call is
instructed to read before working and append findings to afterwards. The
runner never reads or parses the file itself — it just guarantees the file
exists (creating parent directories if needed, never truncating) and
injects a `SHARED MEMORY` block at the top of the agent's prompt that
prescribes the read-before / append-after protocol.

```js
phase("Survey");
memory("notes/survey.md");
const findings = await agent("Audit src/ for X.", { label: "audit", schema: AUDIT });

phase("Fix");
memory("notes/fix.md");                 // distinct file for the new phase
await parallel(items.map(it => () =>
  agent(`Apply finding ${it.id}.`, { label: `fix:${it.id}`, schema: FIX }),
));

memory(null);                            // disable for any later agents
```

- `path` is the file the agents share. Absolute paths pass through;
  relative paths are resolved against the **agent's `cwd` at call time**,
  so the same workflow can target multiple worktrees and each agent sees
  a worktree-local file.
- Pass `null` (or omit / empty string) to clear the binding.
- The binding lasts until you change it. There's no nesting / push-pop —
  set per phase as appropriate.
- Per-call override: `agent("...", { memory: "alt.md" })` overrides the
  active binding for one call; `{ memory: false }` disables it for one call.
- Concurrency caveat: parallel agents sharing one file can race on writes.
  The instructed protocol is append-only, which mitigates loss but cannot
  prevent it on simultaneous edits. For strictly-isolated parallel memory,
  give each branch its own file via the per-call override.
- The file lives in the worktree by default, so opencode's `Read`/`Edit`
  tools work on it directly — and changes are visible to subsequent
  agents even though each runs in a fresh opencode session.
- Emits a `memory.set` event whenever the binding changes; each
  `agent.start` event also carries an optional `memoryPath` so the UI /
  NDJSON show which agents saw memory.

### 5.7 `log(msg, meta?)`

A `console.log`-style stream marker emitted as a `workflow.log` event.

```js
log(`batch: ${FILES.length} files`);
log("dispatching round 2", { round: 2, files: FILES.length });
```

- `msg` is a string (template literals are the norm).
- `meta` is optional and stored on the event; surfaced in the WS stream
  and NDJSON. The UI's developer console shows it under `[log]`.

### 5.8 `args`

`Object.freeze`d input payload, sourced (in this priority order):

1. `--args-json '<json>'` CLI flag.
2. `--args-file <path>` CLI flag (file contents parsed as JSON).
3. Stdin, if no TTY is attached. Parsed as JSON; if parsing fails it's
   passed through as `{ raw: "<original>" }`.
4. Empty `{}` if none of the above.

Inside the workflow, `args` is whatever shape the caller passed. Defensive
patterns from the Bun corpus:

```js
const REPO = (args && args.repo) || "/root/bun-5";
const A = typeof args === "string" ? JSON.parse(args) : args || {};
const FILES = (A.files || []).slice(0, A.maxBatch ?? 100);
if (FILES.length === 0) return { error: "no files in args.files" };
```

### 5.9 JSON Schema conventions

`schema` accepts a subset of JSON Schema (everything in the Bun corpus
plus a bit more, via Ajv with `strict: false`, `allowUnionTypes: true`):

| Construct | Supported | Notes |
|---|---|---|
| `type: "object" \| "string" \| "number" \| "integer" \| "boolean" \| "array" \| "null"` | yes | |
| `type: ["string", "null"]` | yes | union types |
| `required: [...]` | yes | usually populated everywhere |
| `properties: { … }` | yes | |
| `items: { … }` | yes | including nested objects |
| `enum: [...]` | yes | with or without outer `type` |
| `description: "..."` | yes | doubles as agent guidance (see below) |
| `additionalProperties` | yes | |
| `$ref`, `$defs` | yes (Ajv) | |
| top-level array schema | yes | but wrap in object for the Bun-corpus convention |

#### `description` is operational guidance

The runner inlines the entire schema (descriptions included) into the
prompt, prefaced by:

```
──────────────────────── RESPONSE FORMAT ────────────────────────
Respond with a single JSON object matching this JSON Schema and
nothing else. No prose, no markdown, no code fences. If you cannot
comply, emit `{}` rather than free text.

```json
{ … your schema … }
```
```

So `description` strings act as micro-prompts. Use them:

```js
const SCHEMA = {
  type: "object",
  required: ["action", "reason"],
  properties: {
    action: {
      enum: ["DELETE", "TYPE_ONLY", "MOVE_DOWN", "FORWARD_DECL", "GENUINE"],
      description: "DELETE=remove the use, dead/over-import/alias-leftover. TYPE_ONLY=only the type definition is needed, move it to a leaf crate. ...",
    },
    reason: { type: "string", description: "≤120 chars: what the usage actually does" },
  },
};
```

#### Extraction algorithm

The runner extracts the JSON object from the assistant's reply in this
order:

1. **Strict parse** of the trimmed text.
2. **Fenced-block parse** — strip a `\`\`\`json … \`\`\`` (or unmarked
   `\`\`\`` ) fence.
3. **Balanced-braces scan** — find the first top-level `{ … }` pair.

If none parse, `agent.end.reason === "schema"` and `agent()` returns
`null`. Ajv validation runs on the parsed object; failures also yield
`null`.

---

## 6. CLI reference

```
agent-runner run <workflow>     Execute a workflow file
agent-runner web                Read-only history viewer
agent-runner replay <runId>     Replay a saved run
```

### 6.1 `run`

```
agent-runner run <workflow.js> [options]
```

| Option | Default | Effect |
|---|---|---|
| `--args-file <path>` | — | JSON file used as `args`. |
| `--args-json <json>` | — | Inline JSON `args` (overrides `--args-file` and stdin). |
| `--config <path>` | autodetect | Path to a `runner.config.{ts,js,mjs,json}`. |
| `--web-port <n>` | `7777` | Web UI port. Set to `0` to disable the web server entirely. |
| `--no-open` | open browser | Skip auto-opening the browser. |
| `--runs-dir <path>` | `.runner/runs` | NDJSON output root. |
| `--cwd <path>` | `process.cwd()` | Default cwd for agents without `opts.cwd`. |
| `--log-level <l>` | `info` | `trace`/`debug`/`info`/`warn`/`error`. |

#### Stdin behaviour

If no `--args-*` flag is passed and stdin is not a TTY, the runner reads
stdin until EOF and parses it as JSON. This is the canonical
driver-script pattern:

```bash
bun scripts/port-batch.ts head 100 | bun bin/agent-runner run phase-a-port.workflow.js
```

The driver script writes one line of JSON to stdout; the runner consumes
it as `args`.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | `workflow.end.ok === true`. |
| `1` | `workflow.end.ok === false` (workflow threw or returned an error sentinel — *return value, not the runner*). |
| `2` | Runner itself crashed. |

#### Config autodetect

If `--config` isn't given, the runner looks in the *cwd from which it was
launched* (not the workflow's directory) for one of:

1. `runner.config.ts`
2. `runner.config.js`
3. `runner.config.mjs`
4. `runner.config.json`

The first match wins. If none exist, all-default config is used. See
[§7](#7-configuration).

### 6.2 `web`

```
agent-runner web [--port 7777] [--runs-dir .runner/runs]
```

Starts the same HTTP + WS server *without* running a workflow. Useful
for browsing the history of past runs and replaying them on demand. The
process blocks until `SIGINT`.

### 6.3 `replay`

```
agent-runner replay <runId> [--web-port 7777] [--runs-dir .runner/runs] [--speed 1x|2x|max]
```

Reads `<runs-dir>/<runId>/events.ndjson` and re-streams it into a fresh
WebSocket room with a new `runId`. The web UI shows it as a live run.

| Option | Effect |
|---|---|
| `--speed 1x` | Real time (use the original event timestamps). |
| `--speed 2x` | Twice as fast. |
| `--speed max` | No delays — fire as fast as possible. |

Useful for debugging UI rendering, screen recording demos, or letting
someone "replay" a run that already finished.

---

## 7. Configuration

The runner looks for `runner.config.{ts,js,mjs,json}` in the launch cwd.
Bun imports `.ts` configs directly with zero setup. Example:

```ts
// runner.config.ts
import type { RunnerConfig } from "./agent_runner/src/config/types";

export default {
  // Provider/model used by `agent()` when opts.model is omitted.
  defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },

  // opencode agent profile name used when opts.agent is omitted.
  defaultAgent: "build",

  // Used by `agent()` when opts.cwd is omitted.
  defaultCwd: process.cwd(),

  // Two-tier concurrency caps.
  maxAgentsTotal: 8,                  // global semaphore
  maxAgentsPerWorktree: 3,            // per-cwd semaphore
  agentTimeoutMs: 10 * 60 * 1000,     // per `agent()` call

  // opencode subprocess configuration.
  opencode: {
    binary: "opencode",               // resolved on $PATH
    hostname: "127.0.0.1",
    bootTimeoutMs: 30_000,
    extraConfig: {                    // forwarded as opencode `Config`
      autoupdate: false,
      share: "disabled",
    },
  },

  // MCP servers, forwarded as opencode `Config.mcp`. Static at boot.
  mcp: {
    // mcpServerName: { command: "...", args: [...] }
  },

  // Web UI.
  web: { port: 7777, openBrowser: true },

  // Where to put NDJSON event logs and meta.json / result.json.
  runsDir: ".runner/runs",

  // After each run, prune older runs so at most this many remain.
  retention: { maxRuns: 200 },
} satisfies RunnerConfig;
```

### Field reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `defaultModel` | `{ providerID, modelID } \| null` | `null` | Per-call override via `agent({ model })`. If both are null, opencode picks based on its own config. |
| `defaultAgent` | `string \| null` | `null` | opencode agent profile. |
| `defaultCwd` | `string` | `process.cwd()` | |
| `maxAgentsTotal` | `number` | `8` | Total `agent()` calls in flight across all cwds. |
| `maxAgentsPerWorktree` | `number` | `3` | Per unique cwd. |
| `agentTimeoutMs` | `number` | `600_000` | Default deadline for `agent()`; overridable per call. |
| `opencode.binary` | `string` | `"opencode"` | Currently unused — `createOpencodeServer` is invoked from the SDK, not via subprocess. Kept for forward compatibility. |
| `opencode.hostname` | `string` | `"127.0.0.1"` | Where opencode listens. Use `0.0.0.0` to expose externally. |
| `opencode.bootTimeoutMs` | `number` | `30_000` | Max time to wait for the first opencode server. |
| `opencode.extraConfig` | `Record<string, unknown>` | `{}` | Merged into opencode's `Config` at boot. See opencode's own docs. |
| `mcp` | `Record<string, unknown>` | `{}` | MCP servers spec, forwarded into opencode config. |
| `web.port` | `number` | `7777` | `0` disables the web server. |
| `web.openBrowser` | `boolean` | `true` | Auto-open `http://host:port/run/<id>`. |
| `runsDir` | `string` | `".runner/runs"` | Relative paths are resolved from launch cwd. |
| `retention.maxRuns` | `number` | `200` | Number of run directories to keep. |

### CLI overrides

`--config`, `--web-port`, `--no-open`, `--runs-dir`, `--cwd` override the
matching config values. CLI > config > default.

---

## 8. Web UI

The UI is mounted on the same HTTP server as the REST/WS API. Build it
with `bun run build:web` (one-time); the runner serves
`web/dist/index.html` and assets. If `web/dist` is missing (e.g. when
running the compiled binary on a machine without a checkout), a
self-contained inline fallback UI ships embedded in `src/server/http.ts`.

### Pages

| Route | Use |
|---|---|
| `/runs` | History list. Reads `RunIndex`; no WS. |
| `/run/:runId` | Live run view (`PhaseTimeline` + `AgentGrid`). Subscribes via WS. |
| `/run/:runId/agent/:agentId` | Agent drilldown (full prompt + raw text + every tool call). |

### Components

- **`PhaseTimeline`** — horizontal strip of pills driven by `meta.phases`.
  The currently `phase.mark`-active pill is highlighted; counts come from
  the `phase` tag on each `agent.start`.
- **`AgentGrid`** — CSS-grid of `AgentCard`s, one per `agent.start`.
  Reflows on completion; cards keep their slot.
- **`AgentCard`** — header (label, phase chip, model, elapsed, status
  dot, `SchemaBadge`), live `TokenStream`, `ToolCallList`.
- **`TokenStream`** — auto-scrolls to bottom; freezes auto-scroll when
  the user scrolls up; resumes when they scroll back to the bottom.
- **`ToolCallList`** — orders calls by their part-ordinal (first-seen
  position in the SSE stream). Each call uses a tool-specific renderer:
  - `BashView` — command + stdout/stderr.
  - `DiffView` — for `edit` / `write`, shows `old_string` / `new_string`
    or `content`.
  - `GenericView` — collapsible JSON for anything else.
- **`SchemaBadge`** — grey (no schema), grey-while-running (schema set,
  not finished), green (schema validated), red with hover-tooltip (schema
  fail with reason).
- **`TranscriptModal`** — full transcript in the agent drilldown page.

### WebSocket protocol (`/ws/run/:runId`)

Client → server:

| `type` | Effect |
|---|---|
| `subscribe` | Implicit on connect; no payload required. |
| `abort` | Calls every registered abort callback for this runId. Equivalent to "abort all running agents". |
| `abort-agent` (planned) | Abort one agent by id; not wired in v0.1. |

Server → client:

| `type` | Payload |
|---|---|
| `snapshot.begin` | `{ runId }` — sent on connect, before history replay. |
| `event` | `{ event: RunnerEvent }` — one event from the bus or the saved NDJSON. |
| `snapshot.end` | sent once history replay completes; subsequent `event`s are live. |

On connect the server replays the full `events.ndjson` then upgrades to
live tail — the client gets a complete picture regardless of when it
connected.

### REST API

| Route | Returns |
|---|---|
| `GET /api/runs` | `RunIndexEntry[]` — all runs sorted by mtime descending. |
| `GET /api/run/:runId/events` | `RunnerEvent[]` — the full NDJSON parsed as a JSON array. |

---

## 9. Persistence and replay

### NDJSON event log

Every `bus.emit` is appended to `.runner/runs/<runId>/events.ndjson` —
one JSON object per line. Flush policy: 4 KB *or* 64 events *or* 100 ms,
whichever comes first. On `workflow.end` a final fsync runs and the
result is written to `result.json`.

Example tail:

```
{"kind":"workflow.start","runId":"a1b2-…","workflowPath":"/abs/path/foo.workflow.js","meta":{"name":"foo",…},"args":{…},"t":1715724000123}
{"kind":"phase.mark","runId":"a1b2-…","title":"Implement","t":1715724000456}
{"kind":"agent.start","runId":"a1b2-…","agentId":"…","label":"impl:a.zig","phase":"Implement","cwd":"/repo","prompt":"…","schemaHash":"…","t":1715724000789}
{"kind":"agent.token","runId":"a1b2-…","agentId":"…","partID":"prt_1","ordinal":1,"delta":"Hello","t":…}
{"kind":"agent.tool.start","runId":"a1b2-…","agentId":"…","callID":"call_1","ordinal":2,"tool":"bash","input":{"command":"ls"},"t":…}
{"kind":"agent.tool.result","runId":"a1b2-…","agentId":"…","callID":"call_1","tool":"bash","status":"completed","output":"…","elapsedMs":42,"t":…}
{"kind":"agent.end","runId":"a1b2-…","agentId":"…","ok":true,"reason":"idle","output":{…},"rawText":"…","elapsedMs":15234,"t":…}
{"kind":"workflow.end","runId":"a1b2-…","ok":true,"result":{…},"t":…}
```

The NDJSON is the canonical record. The web UI, the replay command, and
any downstream `aggregate-*.ts` scripts you write should consume it
directly.

### `meta.json`

Written once at run start. Includes runId, workflow path + SHA-256,
meta, args, the resolved config, and `startedAt`. Useful for the history
listing without having to scan the event log.

### `result.json`

Written at `workflow.end`. Shape:

```json
{
  "ok": true,
  "result": { /* whatever the workflow returned */ }
}
```

or

```json
{
  "ok": false,
  "error": { "message": "...", "stack": "..." }
}
```

### Retention

After each successful run, `RunStore.pruneOld` deletes the oldest
directories (by mtime) until at most `config.retention.maxRuns` remain.
Default is 200 runs.

### Replay

```bash
bun bin/agent-runner replay <runId> --speed 2x
```

Generates a *new* runId (so the original isn't overwritten in the UI's
state) and re-emits every event into the bus with the new id. The web UI
subscribes and displays it as if it's running live. Useful for:

- Sharing a recording without sharing a live session.
- Debugging UI rendering against a known event sequence.
- Verifying determinism — replay the same NDJSON twice, the UI snapshots
  should match.

---

## 10. Architecture

### Process model

```
┌────────────────────────────────────────────┐
│ agent-runner process (bun)                 │
│                                            │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │ Workflow VM  │───▶│  EventBus        │  │
│  │ (AsyncFn)    │    │                  │  │
│  └──────────────┘    │  ├ stdout        │  │
│         │            │  ├ RunStore (NDJSON)
│         ▼            │  └ WsHub          │  │
│  ┌──────────────┐    └──────────────────┘  │
│  │ Primitives   │            │             │
│  │  - agent()   │            ▼             │
│  │  - pipeline()│    ┌─────────────┐       │
│  │  - parallel()│    │ Bun.serve   │       │
│  │  - phase()   │    │ HTTP + WS   │       │
│  │  - log()     │    └─────────────┘       │
│  └──────────────┘                          │
│         │                                  │
│         ▼                                  │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │OpencodeDriver│───▶│ WorktreeServer A │──┼─▶ opencode server (cwd=A)
│  │              │    └──────────────────┘  │
│  │  Map<cwd,    │    ┌──────────────────┐  │
│  │  Worktree>   │───▶│ WorktreeServer B │──┼─▶ opencode server (cwd=B)
│  └──────────────┘    └──────────────────┘  │
│         │                                  │
│         ▼ SSE pump per server              │
│  SessionTracker(per agent() call)          │
└────────────────────────────────────────────┘
```

### Concurrency

Two semaphores (`src/util/pLimit.ts`). Every `agent()` call:

1. Acquires the **global** `agentPool` slot first.
2. Then acquires the **per-worktree** pool slot for its cwd.

Both are released in `finally`. Tier order is global-first so that two
worktrees can't both fill their local pools while waiting on global
capacity — that would deadlock.

When a workflow spawns 50 agents and `maxAgentsTotal: 8`, only 8 are
ever in `running` state at once. The other 42 are blocked on `acquire()`
and will emit `agent.start` only when they actually begin running.

### opencode session model

Each `agent()` call:

1. `OpencodeDriver.getServer(cwd)` — boots a `WorktreeServer` if this cwd
   is new, else reuses the existing one.
2. `WorktreeServer.createSession()` — `POST /session?directory=<cwd>` →
   `{ id: sessionID }`.
3. Register a `SessionTracker(sessionID, messageID)` with the server. The
   tracker accumulates text + tool state from the multiplexed
   `/event` SSE stream, routed by `sessionID` / `messageID`.
4. `WorktreeServer.sendPromptAsync(sessionID, { messageID, model, agent,
   tools, text })` — `POST /session/:id/prompt_async` returns 204; all
   correlation is via SSE.
5. The tracker resolves when it sees `EventSessionIdle` for its sessionID.
6. After idle, `extractJson` runs (if schema set), Ajv validates, and the
   `agent.end` event is emitted with the parsed output or `null`.

The SSE pump (`WorktreeServer.ssePump`) is shared across all sessions on
that cwd's server — one pump, many trackers, dispatch by sessionID. On
disconnect it reconnects with a 1 s backoff.

### SessionTracker

`src/driver/SessionTracker.ts` is the per-session state machine.

- Tokens: each `message.part.updated` with `part.type === "text"` carries
  a `delta` and the current full text. The tracker emits the delta (and
  diff-computes one if `delta` is missing).
- Tool calls: each `message.part.updated` with `part.type === "tool"`
  upserts an `AssembledToolCall` keyed by `callID`. The state machine
  transitions `pending → running → completed | error`; the tracker emits
  one `tool.start` (first sight) and one `tool.result` (completed/error).
- Ordinals: each new part gets a monotonic `ordinal` so the UI can sort
  by part-order rather than arrival-order.

### Cwd probe (planned, not in v0.1)

Plan §"Driver" describes a boot-time probe to detect whether
`POST /session?directory=...` actually honours the directory (making one
opencode server multi-tenant). If yes, the driver skips per-cwd booting
and reuses a single server. v0.1 always boots one server per unique cwd.

---

## 11. Operating the runner

### Driver-script pattern

The Bun corpus uses a stable pattern: a `scripts/foo.ts` produces JSON
on stdout, piped into the runner.

```ts
// scripts/port-batch.ts
const manifest = parseManifest("manifest.json");
const pending = manifest.filter(f => !f.done).slice(0, 100);
process.stderr.write(`batching ${pending.length} files\n`);
console.log(JSON.stringify({ files: pending, repo: process.cwd() }));
```

```bash
bun scripts/port-batch.ts | bun bin/agent-runner run phase-a.workflow.js
```

Diagnostics go to stderr (visible to the operator). The single line of
JSON on stdout becomes the workflow's `args`. Larger state goes in
`/tmp/` files referenced from `args`.

### Aborting

- **SIGINT (Ctrl+C)**: every in-flight `agent()` is aborted; their
  sessions get `DELETE /session/:id/abort`; they emit `agent.end` with
  `reason: "abort"` and return `null` to the workflow. The workflow keeps
  running and probably finishes promptly (its remaining `agent()` calls
  receive their `null` and short-circuit).
- **Web UI "abort" button**: sends `{ type: "abort" }` over WS; same
  effect as SIGINT.
- **Per-agent abort**: not wired in v0.1.

### Watching multiple workflows

`agent-runner run` blocks until the workflow returns. To run several
workflows side-by-side, launch them in separate terminals with different
`--web-port` values; or run them sequentially and use `agent-runner web`
to browse history.

### Long runs

The runner is designed for tens-of-minutes-to-hours runs. Practical
guidance:

- Set `agentTimeoutMs` to ≥ 15 min for compile-heavy work.
- Keep `maxAgentsTotal` modest (the default 8 is conservative). The Bun
  corpus comment claims "~170 wfs editing concurrently" — that was on
  serious hardware; locally, 8–16 is a sane upper bound.
- NDJSON is append-only, so partial runs are still inspectable mid-flight
  — `tail -f .runner/runs/<id>/events.ndjson | jq` works.
- The web UI auto-reconnects on WS close, so transient network blips
  don't lose state.

---

## 12. Troubleshooting

### opencode boot timeout

```
Error: createOpencodeServer aborted
```

`opencode` SDK couldn't start its server within `opencode.bootTimeoutMs`.
Check:

1. `opencode --version` works on PATH.
2. Provider credentials are exported in the same shell.
3. No firewall is blocking 127.0.0.1.
4. Increase `bootTimeoutMs` to 60_000 for slow first-runs.

### `agent.end ok:false reason:"schema"`

The model didn't produce valid JSON, or the JSON didn't match the
schema. Inspect the agent's drilldown page: the "Assistant text" panel
shows the raw output. Common causes:

- Model wrapped the JSON in prose. Fix: tighten the schema's `description`
  fields or your prompt's "respond with JSON only" framing.
- Required field missing. Fix: relax `required` or amend the prompt to
  emphasise it.
- The model used `null` where a `string` was expected. Fix:
  `type: ["string", "null"]`.

The runner does **not** auto-reprompt. Wrap your `agent()` call in a
small retry loop if you need it:

```js
let r = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  r = await agent(prompt, { label: `try-${attempt}`, schema: SCHEMA });
  if (r) break;
}
```

### `agent.end ok:false reason:"timeout"`

The agent exceeded `timeoutMs` (default 10 min). The session was aborted
server-side. Either raise the per-call `timeoutMs`, or split the work
into smaller agents.

### Web UI shows nothing

1. Confirm the run id matches: the stderr line `agent-runner web:
   http://localhost:7777/run/<id>` is the canonical link.
2. Open the browser devtools console — the WS handshake logs there. If
   it says `WebSocket connection ... 426`, the upgrade route isn't being
   hit; check `--web-port`.
3. If `/api/runs` returns `[]` but `.runner/runs/` has directories,
   you're running `agent-runner web` from the wrong cwd — pass
   `--runs-dir`.

### Stack traces show `<anonymous>:NN`

Should never happen — the runner's `remapAsyncFunctionStack` rewrites
those to the workflow path with adjusted line numbers. If you see
`<anonymous>` in a stack, file a bug with the full trace.

### `cannot remove ... Device or resource busy` on Windows

A SmartGit / Zed / Explorer process is watching the directory. Either
close them, or fall back to the "clone into the empty directory" pattern
documented in the build log — `git clone <bare> agent_runner` works even
when the directory exists, as long as it's empty.

---

## 13. Extending

### Embedding the runner programmatically

The CLI is a thin wrapper over a clean API:

```ts
import { loadWorkflow, runWorkflow } from "./agent_runner/src/workflow/vm";
import { EventBus } from "./agent_runner/src/bus/EventBus";
import { OpencodeDriver } from "./agent_runner/src/driver/OpencodeDriver";
import { makeRunContext } from "./agent_runner/src/primitives/runtime";
import { makeAgentPrimitive } from "./agent_runner/src/primitives/agent";
import { pipelineImpl } from "./agent_runner/src/primitives/pipeline";
import { parallelImpl } from "./agent_runner/src/primitives/parallel";
import { makePhasePrimitive } from "./agent_runner/src/primitives/phase";
import { makeMemoryPrimitive } from "./agent_runner/src/primitives/memory";
import { makeLogPrimitive } from "./agent_runner/src/primitives/log";
import { resolveConfig } from "./agent_runner/src/config/defaults";
import { uuid } from "./agent_runner/src/util/uuid";

const wf = await loadWorkflow("./my.workflow.js");
const bus = new EventBus();
const cfg = resolveConfig(undefined, process.cwd());
const driver = new OpencodeDriver(cfg);
const ctx = makeRunContext({ runId: uuid(), bus, driver, config: cfg });

bus.on(ev => console.log(ev.kind, ev));   // any consumer

const res = await runWorkflow(wf, {
  agent: makeAgentPrimitive(ctx),
  pipeline: pipelineImpl,
  parallel: parallelImpl,
  phase: makePhasePrimitive(ctx),
  memory: makeMemoryPrimitive(ctx),
  log: makeLogPrimitive(ctx),
  args: { /* ... */ },
});

await driver.shutdown();
```

This is exactly what `src/cli/run.ts` does, with extra plumbing for the
web server and NDJSON persistence. You can wire your own consumers
(database, message queue, alert system) by subscribing to `bus`.

### Adding tool views to the web UI

`web/src/components/ToolCallList.tsx` switches on `tool.toLowerCase()`.
To add a renderer for, say, `grep`:

1. Create `web/src/components/toolViews/GrepView.tsx` exporting
   `function GrepView({ call }: { call: ToolCallState }) { … }`.
2. Add to the switch in `ToolCallList.tsx`:
   ```tsx
   if (t === "grep") return <GrepView key={c.callID} call={c} />;
   ```
3. `bun run build:web`.

The `call` prop has `tool`, `status`, `input`, `output`, `error`,
`elapsedMs`. Render whatever you like.

### Custom MCP

Forward MCP servers via `config.mcp`. They're statically loaded into
opencode at boot. Per-call MCP override (via `POST /mcp`) is planned for
a future version — see [IMPLEMENTATION_STATUS](../IMPLEMENTATION_STATUS.md).

### Subscribing to specific event kinds

`EventBus.on` is a single-listener API. Add filtering downstream:

```ts
bus.on(ev => {
  if (ev.kind === "agent.tool.start" && ev.tool === "bash") {
    auditBashCall(ev);
  }
});
```

---

## 14. Security model

### AsyncFunction is unsandboxed

The workflow VM uses `new AsyncFunction(...)` (technically the
`AsyncFunction` constructor inherited from `Object.getPrototypeOf(async
function(){}).constructor`). This is **not** a sandbox — the workflow
runs with full Bun privileges, can `process.exit()`, can use Node APIs
via the global namespace, can spawn child processes.

The constraint is by design: workflows in the Bun corpus do things like
synthesise driver scripts on the fly. Sandboxing would be too
restrictive for the use case. Therefore:

- **Operator-authored workflows only.** Do not feed untrusted scripts.
- The injected globals (`agent`, `pipeline`, etc.) are passed as
  parameters — they are not properties of `globalThis`. A workflow can
  *also* reach into `globalThis` if it wants to, but the runner doesn't
  encourage that.

Switching to `vm.Script` later is non-breaking, because globals are
already explicit constructor parameters rather than runtime properties.

### Sub-agent capabilities

Each opencode sub-agent has the full Claude Code tool surface by
default: `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, `WebSearch`,
plus any MCP tools you configure. Sub-agents can edit files in their
cwd, run shell commands, spawn processes, and read network.

Per-call tool allowlisting is supported via `agent({ tools: { bash:
false, edit: true } })`. Use it for narrow tasks ("read-only audit")
where you want defence-in-depth beyond prompt-level rules.

### Network exposure

By default the HTTP+WS server binds `127.0.0.1` (loopback only). To
expose the UI to your network, set `opencode.hostname: "0.0.0.0"` in
config and ensure your firewall rules are appropriate. There is **no
authentication** on the UI — anyone who can reach the port can view
prompts, outputs, and click "abort". Treat this as an internal-only
debugging tool.

### Persisted secrets

NDJSON event logs contain the full prompt text and full assistant output
of every agent. If your prompts include credentials, those credentials
end up on disk in `.runner/runs/`. Consider:

- Adding `.runner/` to your `.gitignore` (already done in this repo).
- Using `agent.tool.start` events filtered out if they contain
  credentials (subscribe to the bus and write a sanitised log instead of
  the default NDJSON).
- Setting `retention.maxRuns` to a small number for sensitive workloads.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **Workflow** | A `.workflow.js` script — one round of orchestration. |
| **Sub-agent** | One opencode session spawned by `agent()`. Has full Claude Code tool surface. |
| **Pipeline** | Per-item, streaming, multi-stage orchestration via `pipeline()`. |
| **Phase** | A logical chunk of the workflow declared in `meta.phases` and marked at runtime by `phase("...")`. Distinct from `agent({ phase })` which tags individual sub-agents. |
| **Shared memory** | A workflow-bound notes file (`memory(path)`) that subsequent agents read first and append findings to — file-backed scratchpad letting agents communicate across stages without conversational context. |
| **2-vote** | Adversarial pattern: same prompt run by two independent agents, only proceeding when both agree. |
| **Driver script** | An external script (e.g. `scripts/port-batch.ts`) that produces JSON `args` on stdout, piped into the runner. |
| **Worktree server** | One opencode server process per unique `cwd`. |
| **SessionTracker** | Per-`agent()` state assembler that consumes the multiplexed SSE stream. |
| **EventBus** | In-process pub/sub used by primitives, persistence, and the WS server. |
| **NDJSON** | Newline-delimited JSON — the on-disk event log format. |
| **RunStore** | Buffered NDJSON writer + `meta.json` / `result.json` + retention prune. |
| **RunIndex** | Read-side scanner over `.runner/runs/*` for the history UI. |
| **Replay** | Re-emit a saved NDJSON into a fresh WS room as if it were live. |
| **Schema-null** | The contract: invalid output → `agent()` returns `null` instead of throwing. |
| **Per-message tool allowlist** | The `tools: { bash: false }` option on `agent()`. |

---

*End of manual. Bug reports and follow-up work tracked in
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).*
