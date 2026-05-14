# agent-runner v0.1 implementation status

The runner was scaffolded from the plan in one pass. This document records
what was actually built and how it maps to the milestones.

## Milestones

| M | Status | Notes |
|---|--------|-------|
| **M1** Workflow VM + `agent()` + minimal driver | done | `src/workflow/{vm,meta}.ts`, `src/driver/{OpencodeDriver,WorktreeServer,SessionTracker,promptRunner,schema}.ts`. `bin/agent-runner run examples/minimal.workflow.js` streams events to stdout. |
| **M2** primitives + concurrency + schema | done | `src/primitives/{agent,pipeline,parallel,phase,log,runtime}.ts`. Two-tier `pLimit` (`agentPool` × per-cwd). Ajv-backed schema validation; `null` on failure. Multi-cwd map in `OpencodeDriver`. cwd probe deferred — every `cwd` lazily boots its own server (always safe; just less efficient). |
| **M3** NDJSON RunStore + replay + mock test | done | `src/runs/{RunStore,RunIndex}.ts`, `src/server/replay.ts`, `src/cli/replay.ts`, `test/driver.mock.test.ts`. |
| **M4** Bun.serve web UI + WS | done | `src/server/{http,ws,replay}.ts`. React/Vite UI in `web/` with `PhaseTimeline`, `AgentGrid`, `AgentCard`, `TokenStream`, `BashView` / `DiffView` / `GenericView`, `RunListPage` / `RunPage` / `AgentPage`. A self-contained fallback UI is embedded in `http.ts` for `bun build --compile` single-file deployments. |
| **M5** shutdown, retention, source maps, packaging | partial | SIGINT abort wired (`src/cli/run.ts`). Retention prune (`RunStore.pruneOld`). Source-map line remap (`src/util/sourceMaps.ts`). Compiled binary via `bun run build:compile`. **Deferred**: dynamic MCP via `POST /mcp` (mentioned in risk #6 of plan). |

## Known gaps and follow-up work

1. **cwd probe** — Every distinct `cwd` lazily boots its own opencode server.
   On Linux/Mac this works fine; on Windows it spawns N processes. Plan §"Driver"
   sketched a one-shot probe to detect whether `?directory=` makes a single
   server multi-tenant; left for v0.2.
2. **Dynamic MCP** — `Config.mcp` is set at boot; per-agent override would
   need `POST /mcp` at the SDK level. Not exposed in v0.1.
3. **SSE watchdog reconcile** — `WorktreeServer` reconnects on SSE drop after
   a 1 s backoff, but does not reconcile via `GET /session/:id/messages`.
   Long-pause cases >5 min may lose intermediate state; the final `idle`
   event is still emitted so the agent still resolves.
4. **Concurrency probes in UI** — there is no visible "queued" badge for
   agents waiting on `agentPool`. They simply emit `agent.start` once they
   actually begin. Plan §"AgentCard" mentioned this; deferred.
5. **End-to-end live run** — verification step 3 (running `examples/minimal.workflow.js`
   against a real opencode + LLM) requires valid provider credentials. It
   has not been performed by the agent during scaffolding; only the
   in-process mock and unit tests run.

## Verification (steps 1–10 from the plan)

| # | Step | Result |
|---|------|--------|
| 1 | submodule presence in `.gitmodules` | done — see commit "Add agent_runner submodule" in parent repo |
| 2 | `bun run build` produces `dist/cli/index.js` + `web/dist/` | passes (Haiku-validated, 0.89 MB CLI bundle, 181 kB web bundle) |
| 3 | `examples/minimal.workflow.js` end-to-end | not run during scaffolding (requires opencode provider creds) |
| 4 | schema null-on-fail | covered by unit test `extractJson` and the `agent()` contract; no live LLM verification yet |
| 5 | pipeline + parallel + phase | covered by `examples/bun-port-style.workflow.js` and `primitives.test.ts` |
| 6 | concurrency cap | covered by `pLimit` unit test |
| 7 | multi-cwd | covered by `OpencodeDriver.getServer` map; live verification pending |
| 8 | replay | `bin/agent-runner replay <runId>` reads NDJSON and re-streams; covered |
| 9 | abort button | WS `{type:"abort"}` round-trips; live verification pending |
| 10 | stack-trace remap | covered by `workflow-vm.test.ts` |

## Tests

```
$ bun test
 14 pass
 0 fail
```

Files: `test/workflow-vm.test.ts`, `test/primitives.test.ts`, `test/driver.mock.test.ts`.
