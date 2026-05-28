import { compileSchema, describeSchemaForPrompt, extractJson, type JSONSchema } from "./schema.ts";
import { SessionTracker, addTokenStats, emptyTokenStats, type ConversationTokenStats } from "./SessionTracker.ts";
import { WorktreeServer } from "./WorktreeServer.ts";
import { ascendingMessageId } from "../util/uuid.ts";

export type { ConversationTokenStats };

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
  // Fired immediately before each user message is sent to opencode — the
  // initial attempt (req.prompt + schema description) AND every retry
  // (buildRetryPrompt). `text` is the exact bytes opencode receives, so the
  // per-agent log can reconstruct what the model actually saw rather than
  // what the workflow author wrote.
  onUserPrompt?: (attempt: number, text: string) => void;
}

export type PromptResult =
  | { ok: true; data: unknown; rawText: string; elapsedMs: number; tokens: ConversationTokenStats }
  | { ok: false; reason: "schema" | "abort" | "http" | "timeout" | "idle" | "internal"; message?: string; rawText: string; elapsedMs: number; tokens: ConversationTokenStats };

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

  // Rolling conversation-size totals — a NEW SessionTracker is created per
  // attempt against the same opencode session, so per-tracker stats reset on
  // every retry. We accumulate here so the final number reflects everything
  // sent/received across the whole agent() call.
  let cumulativeTokens: ConversationTokenStats = emptyTokenStats();

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
        tokens: cumulativeTokens,
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
        return { ok: false, reason: "abort", rawText: lastRawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
      }

      // Use ascendingMessageId() (not random UUID hex) so the user
      // messageID sorts lexicographically BEFORE any opencode-generated
      // assistant ID. opencode's runLoop break check is a string compare
      // `lastUser.id < lastAssistant.id`; a random `msg_<uuid>` violates
      // that ~12% of the time in the current epoch, which makes opencode
      // loop forever generating empty assistant messages. See uuid.ts.
      const messageID = ascendingMessageId();
      const text = attempt === 0
        ? (req.schema ? `${req.prompt}\n${describeSchemaForPrompt(req.schema)}` : req.prompt)
        : buildRetryPrompt(lastRawText, lastSchemaError, req.schema!);

      req.onSessionAssigned(sessionID, messageID);
      if (attempt > 0) {
        req.onSchemaRetry?.(attempt, lastSchemaError);
      }
      req.onUserPrompt?.(attempt, text);

      tracker = new SessionTracker(sessionID!, messageID, {
        onTokenDelta: req.onTokenDelta,
        onReasoningDelta: req.onReasoningDelta,
        onToolStart: req.onToolStart,
        onToolResult: req.onToolResult,
        onRawEvent: req.onRawEvent,
        onSessionIdle: () => {},
        onSessionError: () => {},
      });
      // Tell the per-attempt tracker about the exact bytes we're sending so
      // tokenStats() can include them on the input side once the attempt
      // settles.
      tracker.noteUserPrompt(text);
      server.registerTracker(tracker);

      try {
        await server.sendPromptAsync(sessionID, {
          messageID,
          model: req.model,
          agent: req.agent,
          tools: req.tools,
          text,
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (tracker) {
          server.unregisterTracker(tracker);
          // Even on transport failure, fold in whatever the tracker observed
          // (mostly the user prompt itself) so the caller doesn't see a 0
          // budget after a partially-sent attempt.
          cumulativeTokens = addTokenStats(cumulativeTokens, tracker.tokenStats());
        }
        return {
          ok: false,
          reason: "http",
          message: (err as Error).message,
          rawText: lastRawText,
          elapsedMs: Date.now() - t0,
          tokens: cumulativeTokens,
        };
      }

      // whenDone() resolves on ANY terminal transition: session.idle,
      // session.error, or our local markAbort/markTimeout/markInternal. The
      // old pattern of awaiting a promise wired only to onSessionIdle/onError
      // could deadlock if the outer timer (req.timeoutMs) fired — markTimeout
      // set done=true but never resolved the await, so the runner just hung
      // with no error and no retry.
      await tracker.whenDone();
      server.unregisterTracker(tracker);

      const rawText = tracker!.finalText();
      const reason = tracker!.reason();
      lastRawText = rawText;
      // Fold this attempt's input+output bytes into the running total before
      // we exit any branch below.
      cumulativeTokens = addTokenStats(cumulativeTokens, tracker!.tokenStats());

      // Hard-fail conditions: don't retry on abort/timeout/transport error.
      if (aborted || reason === "abort") {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: "abort", rawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
      }
      if (reason === "timeout") {
        if (timer) clearTimeout(timer);
        if (sessionID) await server.abortSession(sessionID);
        return { ok: false, reason: "timeout", rawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
      }
      if (reason === "error") {
        if (timer) clearTimeout(timer);
        return {
          ok: false,
          reason: "internal",
          message: tracker!.errorMessage(),
          rawText,
          elapsedMs: Date.now() - t0,
          tokens: cumulativeTokens,
        };
      }
      if (reason !== "idle") {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: "idle", rawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
      }

      // No schema → first idle is the final answer; no retries possible.
      if (!req.schema || !compiledValidate) {
        if (timer) clearTimeout(timer);
        return { ok: true, data: rawText.trim(), rawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
      }

      // For multi-step agents that called tools, narrow JSON extraction to
      // the text emitted AFTER the last tool call — that's the model's final
      // reply. Earlier prose (planning, tool-input echoes like
      // "I'll read with {\"file\": \"x.json\"}", intermediate scratch shapes)
      // contains balanced-brace candidates that extractJson would otherwise
      // pick up and rank ahead of the real answer. Simple agents emit no
      // tool calls; finalAnswerText() returns "" in that case and we fall
      // back to the full rawText so their behaviour is unchanged.
      const answerSlice = tracker!.finalAnswerText();
      const extractSource = answerSlice || rawText;
      const parsed = extractJson(extractSource, {
        validate: (d) => compiledValidate(d).ok,
      });
      if (parsed === undefined) {
        lastSchemaError = "Response contained no parseable JSON. Reply with ONLY a JSON object — no prose, no markdown, no code fences, no preamble. First character must be `{`.";
        continue;
      }
      const v = compiledValidate(parsed);
      if (!v.ok) {
        lastSchemaError = `Schema validation failed: ${v.errors.join("; ")}`;
        continue;
      }

      if (timer) clearTimeout(timer);
      return { ok: true, data: v.data, rawText, elapsedMs: Date.now() - t0, tokens: cumulativeTokens };
    }

    // Out of retries — agent is considered dead.
    if (timer) clearTimeout(timer);
    return {
      ok: false,
      reason: "schema",
      message: `exhausted ${maxRetries} schema retries; last error: ${lastSchemaError}`,
      rawText: lastRawText,
      elapsedMs: Date.now() - t0,
      tokens: cumulativeTokens,
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
    "Your previous response did not satisfy the required JSON schema.",
    "",
    `Validator said: ${schemaError}`,
    "",
    "What you returned:",
    "<<<",
    excerpt,
    ">>>",
    "",
    "Reply again. Strict rules:",
    "  • Output ONLY the JSON value — no prose before or after.",
    "  • No markdown, no code fences, no \"```json\" wrapper.",
    "  • No preamble like \"Here is\" or \"Sure,\".",
    "  • The first character of your reply must be `{` (or `[`).",
    "  • The last character must be `}` (or `]`).",
    "  • Fill every required field with real data — do not return `{}` as a placeholder.",
    "",
    "Schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}
