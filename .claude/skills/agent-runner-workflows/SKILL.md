---
name: agent-runner-workflows
description: >-
  Author and run dynamic multi-agent workflows for THIS repository using the
  local agent-runner engine instead of Claude Code's built-in workflow runtime.
  TRIGGER whenever the user asks for a "workflow", multi-agent orchestration, a
  fan-out/pipeline of subagents, a codebase audit/migration/sweep, or to write
  or run a `*.workflow.js` script in this project. agent-runner is an API clone
  of Claude Code dynamic workflows (same globals and `meta` export) that runs on
  opencode and adds custom runner tools and a shared memory file.
---

# agent-runner workflows

This repo is a self-hosted clone of Claude Code's dynamic-workflow runtime. For
any dynamic/multi-agent workflow **in this repo**, do NOT use the built-in
Claude Code `Workflow` tool — write a `*.workflow.js` script and run it through
the agent-runner CLI.

## Running

```bash
agent-runner run <workflow.js> [--args-json '{...}'] [--args-file <p>] [--noweb]
agent-runner replay <runId> [--speed 1x|2x|max]
```

A live web UI **opens by default** at `http://localhost:7777/run/<runId>`. Use
`--noweb` for headless runs (no server, no browser), or `--no-open` to keep the
server but not open a browser. Pass workflow input via `--args-json`,
`--args-file`, or stdin (lands in the `args` global).

## Authoring a script

Same shape as Claude Code dynamic workflows: a `meta` export plus a body using
the injected globals, with top-level `await` and `return` allowed.

```js
export const meta = {
  name: "audit-routes",
  description: "Audit route files for missing auth checks.",
  phases: [{ title: "Find" }, { title: "Verify" }],
};

phase("Find");
const { files } = await agent("List route files under src/routes/.", {
  schema: { type: "object", required: ["files"],
            properties: { files: { type: "array", items: { type: "string" } } } },
});

phase("Verify");
const results = await pipeline(
  files,
  (f) => agent(`Check ${f} for missing auth.`, { phase: "Verify", schema: FINDING }),
);
return results.filter(Boolean);
```

Injected globals (identical to the built-in runner): `agent(prompt, opts)`,
`pipeline(items, ...stages)`, `parallel(thunks)`, `phase(title)`,
`log(msg, meta?)`, `args`.

## How it differs from built-in workflows

- **`agent()` always returns JSON or `null` and never throws** — filter results
  with `.filter(Boolean)` instead of try/catch. With no `schema` it still
  returns a parsed object; pass `schema` for a strict shape.
- **`agent()` options**: `label`, `phase`, `schema`, `model`
  (`{ providerID, modelID }`), `agent`, `tools`, `cwd`, `timeoutMs`,
  `maxSchemaRetries`, `memory`, `onMetrics`.
- **Custom runner tools via `defineTool(name, opts, handler)`** — register a JS
  callback the sub-agents invoke as a tool. **Must be called before the first
  `agent()`.** `opts.inputSchema` must be `type:"object"`; the name must match
  `/[A-Za-z0-9_.-]+/`.

  ```js
  defineTool("lookup_ticket", {
    description: "Fetch a ticket by id.",
    inputSchema: { type: "object", required: ["id"],
                   properties: { id: { type: "string" } } },
  }, async ({ id }) => ({ status: "open", id }));
  ```

- **Shared `memory()` scratchpad** — `memory("notes.md")` binds a markdown file
  that successive `agent()` calls read/append; `memory(null)` unbinds; per-call
  `agent(prompt, { memory })` overrides.
- **Better caching**: schema-validation retries re-prompt within the same
  opencode session, so keep stable/reusable context at the front of a prompt and
  variable bits at the end.

## Prompt-cache optimization (do this for large fan-outs)

On runs that spawn many agents, reuse Anthropic's prompt cache by giving every
spawn a **byte-identical** large prefix:

- Write an opencode agent profile to disk **before the first `agent()` call**,
  with the big stable context (role, rules, an inlined reference doc such as the
  target repo's `CLAUDE.md`) in its system prompt, then spawn via
  `agent(userPrompt, { agent: "<name>" })`. opencode reads `.opencode/agent/*.md`
  once at boot, so the long system prompt is shared and cached across all spawns.

  ```js
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const SYSTEM = `You are a read-only reviewer...\n\n# Reference\n${claudeMd}`;
  await fs.mkdir(path.join(ROOT, ".opencode", "agent"), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, ".opencode", "agent", "reviewer.md"),
    `---\ndescription: ...\nmode: subagent\n---\n${SYSTEM}\n`, "utf8");
  // ...then, later:
  await agent(taskSpecificPrompt, { agent: "reviewer", tools: READ_ONLY });
  ```

- Keep only the small, per-agent variable bits (the file list, the id, the
  label) in the `agent()` user prompt — at the end, where a cache miss is cheap.
- Define your custom tools and write profiles **before any `agent()`** — opencode
  reads tools and agent profiles once at worktree boot.

See `examples/codebase-review.workflow.js` for a full 12-reviewer fan-out that
uses fixed profiles + custom queue tools.
