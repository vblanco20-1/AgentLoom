import { compileSchema, describeSchemaForPrompt, extractJson, type JSONSchema } from "./schema.ts";
import { SessionTracker } from "./SessionTracker.ts";
import { WorktreeServer } from "./WorktreeServer.ts";
import { uuid } from "../util/uuid.ts";

export interface PromptRequest {
  prompt: string;
  schema?: JSONSchema;
  model?: { providerID: string; modelID: string };
  agent?: string;
  tools?: Record<string, boolean>;
  timeoutMs: number;
  // Max number of schema-failure retries (additional attempts after the
  // initial one). When omitted, defaults to 5 — i.e. up to 6 total attempts
  // before the agent is declared dead.
  maxSchemaRetries?: number;
  // Hooks called as events fire — wired through to the runner EventBus by
  // the caller. The runner's `agent()` primitive is responsible for emitting
  // the bus-level events; this layer is purely the per-call mechanics.
  onSessionAssigned: (sessionID: string, messageID: string) => void;
  onTokenDelta: (partID: string, ordinal: number, delta: string) => void;
  onReasoningDelta: (partID: string, ordinal: number, delta: string) => void;
  onToolStart: (call: import("./SessionTracker.ts").AssembledToolCall) => void;
  onToolResult: (call: import("./SessionTracker.ts").AssembledToolCall) => void;
  onRawEvent: (evType: string, payload: unknown) => void;
  // Fired each time a schema parse/validation failure provokes another round
  // trip to the model. `attempt` is 1-based and counts the retry that's
  // about to happen (1 = first retry after the initial response).
  onSchemaRetry?: (attempt: number, error: string) => void;
}

export type PromptResult =
  | { ok: true; data: unknown; rawText: string; elapsedMs: number }
  | { ok: false; reason: "schema" | "abort" | "http" | "timeout" | "idle" | "internal"; message?: string; rawText: string; elapsedMs: number };

export interface PromptHandle {
  result: Promise<PromptResult>;
  abort: () => Promise<void>;
}

export function runPrompt(server: WorktreeServer, req: PromptRequest): PromptHandle {
  const t0 = Date.now();
  let aborted = false;
  let tracker: SessionTracker | null = null;
  let sessionID: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const maxRetries = req.maxSchemaRetries ?? 5;

  const result = (async (): Promise<PromptResult> => {
    try {
      sessionID = await server.createSession();
    } catch (err) {
      return {
        ok: false,
        reason: "http",
        message: (err as Error).message,
        rawText: "",
        elapsedMs: Date.now() - t0,
      };
    }

    // One timer covers the entire prompt window — including any schema
    // retries. If the model loops indefinitely on a bad-JSON spiral, the
    // outer agentTimeoutMs still rescues us.
    timer = setTimeout(() => {
      tracker?.markTimeout();
    }, req.timeoutMs);

    const compiledValidate = req.schema ? compileSchema(req.schema) : null;
    let lastRawText = "";
    let lastSchemaError = "";

    // attempt 0 = initial request; attempts 1..maxRetries = retries that
    // feed the previous failure back to the model in the same session.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (aborted) {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: "abort", rawText: lastRawText, elapsedMs: Date.now() - t0 };
      }

      // opencode's prompt_async API requires messageID to start with "msg"
      // (validation error: "Expected a string starting with \"msg\"").
      const messageID = `msg_${uuid().replace(/-/g, "")}`;
      const text = attempt === 0
        ? (req.schema ? `${req.prompt}\n${describeSchemaForPrompt(req.schema)}` : req.prompt)
        : buildRetryPrompt(lastRawText, lastSchemaError, req.schema!);

      req.onSessionAssigned(sessionID, messageID);
      if (attempt > 0) {
        req.onSchemaRetry?.(attempt, lastSchemaError);
      }

      const idleP = new Promise<void>((resolve) => {
        tracker = new SessionTracker(sessionID!, messageID, {
          onTokenDelta: req.onTokenDelta,
          onReasoningDelta: req.onReasoningDelta,
          onToolStart: req.onToolStart,
          onToolResult: req.onToolResult,
          onRawEvent: req.onRawEvent,
          onSessionIdle: () => resolve(),
          onSessionError: () => resolve(),
        });
        server.registerTracker(tracker);
      });

      try {
        await server.sendPromptAsync(sessionID, {
          messageID,
          model: req.model,
          agent: req.agent,
          tools: req.tools,
          text,
          // When the caller supplied a schema, also bind opencode's
          // server-side json_schema format so the model's native structured
          // output kicks in (with built-in retry). Our describeSchemaForPrompt
          // block in fullPrompt remains as a fallback for older servers.
          schema: req.schema as Record<string, unknown> | undefined,
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (tracker) server.unregisterTracker(tracker);
        return {
          ok: false,
          reason: "http",
          message: (err as Error).message,
          rawText: lastRawText,
          elapsedMs: Date.now() - t0,
        };
      }

      await idleP;
      server.unregisterTracker(tracker!);

      const rawText = tracker!.finalText();
      const reason = tracker!.reason();
      lastRawText = rawText;

      // Hard-fail conditions: don't retry on abort/timeout/transport error.
      if (aborted || reason === "abort") {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: "abort", rawText, elapsedMs: Date.now() - t0 };
      }
      if (reason === "timeout") {
        if (timer) clearTimeout(timer);
        if (sessionID) await server.abortSession(sessionID);
        return { ok: false, reason: "timeout", rawText, elapsedMs: Date.now() - t0 };
      }
      if (reason === "error") {
        if (timer) clearTimeout(timer);
        return {
          ok: false,
          reason: "internal",
          message: tracker!.errorMessage(),
          rawText,
          elapsedMs: Date.now() - t0,
        };
      }
      if (reason !== "idle") {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: "idle", rawText, elapsedMs: Date.now() - t0 };
      }

      // No schema → first idle is the final answer; no retries possible.
      if (!req.schema || !compiledValidate) {
        if (timer) clearTimeout(timer);
        return { ok: true, data: rawText.trim(), rawText, elapsedMs: Date.now() - t0 };
      }

      const parsed = extractJson(rawText);
      if (parsed === undefined) {
        lastSchemaError = "Response contained no parseable JSON object. Reply with ONLY a JSON object — no prose, no markdown, no code fences.";
        continue;
      }
      const v = compiledValidate(parsed);
      if (!v.ok) {
        lastSchemaError = `Schema validation failed: ${v.errors.join("; ")}`;
        continue;
      }

      if (timer) clearTimeout(timer);
      return { ok: true, data: v.data, rawText, elapsedMs: Date.now() - t0 };
    }

    // Out of retries — agent is considered dead.
    if (timer) clearTimeout(timer);
    return {
      ok: false,
      reason: "schema",
      message: `exhausted ${maxRetries} schema retries; last error: ${lastSchemaError}`,
      rawText: lastRawText,
      elapsedMs: Date.now() - t0,
    };
  })();

  return {
    result,
    abort: async () => {
      if (aborted) return;
      aborted = true;
      tracker?.markAbort();
      if (sessionID) await server.abortSession(sessionID);
    },
  };
}

function buildRetryPrompt(lastRawText: string, schemaError: string, schema: JSONSchema): string {
  // Trim very long replies so a runaway response doesn't blow up the next
  // prompt — the model already has the full text in its conversation
  // history; this is just a pointed reminder of what went wrong.
  const excerpt = lastRawText.length > 800
    ? `${lastRawText.slice(0, 400)}\n…[truncated]…\n${lastRawText.slice(-200)}`
    : lastRawText;
  return [
    "Your previous response could not be parsed against the required JSON schema.",
    "",
    `Error: ${schemaError}`,
    "",
    "Previous response was:",
    "```",
    excerpt,
    "```",
    "",
    "Please reply again with ONLY a single JSON object matching this schema. No prose, no markdown, no code fences:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}
