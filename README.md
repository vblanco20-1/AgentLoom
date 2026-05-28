# agent-runner

Self-hostable multi-agent workflow runner with the same API surface as the
internal orchestrator that ported Bun from Zig to Rust. Uses
[opencode](https://opencode.ai) as the per-agent backend and ships a live web
UI streaming every running agent's tokens and tool calls.

## Relationship to Claude Code dynamic workflows

agent-runner is a **direct, self-hostable clone of the workflow API behind
[Claude Code's dynamic workflows](https://code.claude.com/docs/en/workflows)**.
A workflow is the same thing here as there — a JavaScript script the runtime
executes in the background while it fans out [subagents](https://code.claude.com/docs/en/sub-agents)
— and the authoring surface is intentionally identical: the same injected
globals (`agent`, `pipeline`, `parallel`, `phase`, `log`, `args`), the same
`meta = { name, description, phases }` export, the same schema-validated agent
results, the same non-barrier `pipeline()` stage semantics, and the same
background-execution / resumability model. Scripts written for one largely run
on the other.

Where Claude Code's docs describe a *managed in-client product* (the bundled
`/deep-research` command, the `workflow` keyword and `ultracode` effort mode
that have Claude write the script for you, permission/approval UX, org
governance, and multi-provider billing), agent-runner is the bare orchestration
engine you run yourself — CLI-driven, with no bundled workflows and no
model-in-the-loop authoring. In exchange it adds extras the product surface
doesn't cover:

- **Built on [opencode](https://opencode.ai)** as the per-agent backend rather
  than being baked into a client, so it is fully self-hostable and
  provider-agnostic.
- **Session/message-based prompting for better caching.** Agents drive opencode
  through its session message API with client-minted *ascending* message IDs
  (`ascendingMessageId()`), and schema-validation retries re-prompt **within the
  same session** (`buildRetryPrompt`) instead of spawning a fresh context per
  attempt — keeping the prompt cache warm across retries.
- **`defineTool()` + in-process MCP tool server** — workflows can register JS
  callbacks that sub-agents invoke as MCP tools, routed back into the same Bun
  process.
- **`memory()`** — a shared-memory file threaded across `agent()` calls.
- **`replay <runId>`** — deterministic replay of a recorded run, plus
  `runner.config.ts` for configuration and `--args-file` / `--args-json` /
  stdin for workflow `args`.

### Prompt-cache optimization

Two techniques let a fan-out workflow reuse Anthropic's prompt cache across many
agent spawns, which is where most of the token savings on large runs come from:

1. **Fixed, byte-identical agent profiles.** Write an opencode agent definition
   (`.opencode/agent/<name>.md`, `mode: subagent`) to disk **before the first
   `agent()` call**, put the large stable context there (role, rules, an inlined
   reference doc like `CLAUDE.md`), then spawn with `agent({ agent: "<name>" })`.
   opencode reads the profile once at server boot, so every agent shares a
   byte-identical system prompt and the long prefix is cached after the first
   spawn. Keep the per-agent variable bits (the file list, the task id) in the
   `agent()` *user* prompt — small and at the end, where a cache miss is cheap.
2. **In-session retries.** Schema-validation retries re-prompt within the same
   opencode session (`buildRetryPrompt`) rather than opening a fresh context, so
   the cached prefix survives across attempts.

The rule of thumb is the usual one: **stable/reusable context at the front
(ideally in a fixed agent profile), variable bits at the end.** See
`examples/codebase-review.workflow.js` for both techniques in a 12-reviewer
fan-out.


## Status

Pre-release. v0.1 — see [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for the milestone matrix.
Completely vibecoded and not meant for real usage

## Documentation

- **[`docs/MANUAL.md`](docs/MANUAL.md)** — full user-facing manual: API
  reference, CLI, configuration, web UI, persistence, architecture,
  troubleshooting, extending, security.
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — milestone state.

### Claude Code skill

This repo ships a Claude Code skill at
[`.claude/skills/agent-runner-workflows/SKILL.md`](.claude/skills/agent-runner-workflows/SKILL.md).
When you ask Claude Code for a "workflow", multi-agent orchestration, or to
write/run a `*.workflow.js` in this repo, the skill steers it to author for
agent-runner and run it through this CLI **instead of** Claude Code's built-in
workflow runtime. It documents how to invoke the runner, how the workflow script
differs from the built-in ones (`agent()` returns JSON-or-`null` and never
throws, `defineTool()` custom tools, the `memory()` scratchpad), and the
prompt-cache optimization for large fan-outs. It loads automatically; no setup
needed.

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
agent-runner run <workflow.js> [--args-file <p>] [--args-json <j>] [--web-port 7777] [--noweb] [--no-open] [--runs-dir ./.runner/runs]
agent-runner web  [--port 7777] [--runs-dir ./.runner/runs]
agent-runner replay <runId> [--web-port 7777] [--speed 1x|2x|max]
```

## Security note

The workflow VM uses `new AsyncFunction(...)` — **operator-authored workflows
only**. Do not feed untrusted scripts.

## Licence

AGPL.
