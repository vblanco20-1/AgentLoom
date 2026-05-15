# agent-runner — repo notes for Claude

## Toolchain: bun, not node/npx

This project is built and run with **bun**. Do not invoke `tsc`, `node`, or `npx` directly.

- Build: `bun run build` (or `build:all` for the web UI too)
- Dev: `bun run dev`
- Tests: `bun test`
- Typecheck: `bun run typecheck` — this is the only correct way to run the TypeScript compiler in this repo. `npx tsc` will hit bun's stub and fail.

## Stale-bundle footgun

`bin/agent-runner` historically preferred `dist/cli/index.js` blindly when present. That bites: edit `src/`, run the CLI, the stale dist runs and your changes never hit the runtime — you end up debugging the *old* code while staring at the *new* code. The current bootstrap compares mtimes (newest source file vs. the bundle) and runs from source when source is newer. The standalone `dist/agent-runner.exe` does NOT have this protection; rebuild it explicitly with `bun run build:compile` whenever you touch driver code, or users running the exe will hit the same stale-bundle trap.

## opencode integration gotchas

- `format: { type: "json_schema", ... }` on `session.promptAsync` is **broken** on opencode 1.14.x. It forces `toolChoice: "required"` plus a `StructuredOutput` tool whose args are pre-validated by the AI SDK; when the model emits non-matching JSON the loop returns `"continue"` and re-prompts forever — `session.idle` never fires. The SDK's `retryCount` field is unused on the server side. Do **not** re-enable this without first reading opencode `packages/opencode/src/session/prompt.ts` `runLoop`.
- Schema enforcement is handled out-of-band in `src/driver/promptRunner.ts`: schema is inlined in the prompt via `describeSchemaForPrompt`, response parsed by `extractJson`, and validation failures retried in the same session via `buildRetryPrompt`.
- The real LLM event stream is `/global/event`, not `/event` (which only emits a welcome and closes). Events are wrapped as `{ directory, project, payload }`.
- **User-prompt messageIDs MUST sort lex-before opencode's auto-generated assistant IDs.** opencode's `runLoop` break condition is `lastUser.id < lastAssistant.id` (string compare; `packages/opencode/src/session/prompt.ts`). opencode generates IDs as `msg_<12 hex timestamp bytes><14 base62>` via `Identifier.ascending` (`packages/opencode/src/id/id.ts`). A random `crypto.randomUUID()`-derived hex ID has a ~12% chance of sorting greater than opencode's `msg_e2…` prefix in the current epoch, which silently makes opencode loop forever (no `session.idle` ever fires; runner only escapes via `agentTimeoutMs`). Always mint user messageIDs with `ascendingMessageId()` in `src/util/uuid.ts` — it mirrors opencode's format and our timestamp is strictly earlier than opencode's, keeping the invariant.
