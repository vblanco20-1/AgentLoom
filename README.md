# agent-runner

Self-hostable multi-agent workflow runner with the same API surface as the
internal orchestrator that ported Bun from Zig to Rust. Uses
[opencode](https://opencode.ai) as the per-agent backend and ships a live web
UI streaming every running agent's tokens and tool calls.

## Status

Pre-release. v0.1 — see `IMPLEMENTATION_STATUS.md` for the milestone matrix.

## Quick start

```bash
bun install
bun run build:all
bun bin/agent-runner run examples/minimal.workflow.js
```

This boots an opencode server in-process, fans out one agent, and opens the
live web UI at <http://localhost:7777/run/&lt;runId&gt;>.

## Workflow surface

The runtime injects six globals into every workflow script:

| Global | Use |
|---|---|
| `agent(prompt, opts)` | Spawn one sub-agent. Resolves to schema-validated JSON or `null`. **Never throws.** |
| `pipeline(items, ...stages)` | Per-item streaming pipeline. Stage `n` receives `(prev, originalItem, idx)`. |
| `parallel(thunks)` | `Promise.all` with thunk-not-promise convention. |
| `phase(title)` | Telemetry marker. No return. |
| `log(msg, meta?)` | Telemetry log line. |
| `args` | Frozen input object (from `--args-file` / `--args-json` / stdin). |

Workflows export `meta = { name, description, phases }` and may use
top-level `await` and `return`.

## Configuration

Place `runner.config.ts` (or `.js` / `.json`) next to the workflow. See
`examples/runner.config.example.ts` for the full shape.

## CLI

```text
agent-runner run <workflow.js> [--args-file <p>] [--args-json <j>] [--web-port 7777] [--no-open] [--runs-dir ./.runner/runs]
agent-runner web  [--port 7777] [--runs-dir ./.runner/runs]
agent-runner replay <runId> [--web-port 7777] [--speed 1x|2x|max]
```

## Security note

The workflow VM uses `new AsyncFunction(...)` — **operator-authored workflows
only**. Do not feed untrusted scripts.

## Licence

MIT.
