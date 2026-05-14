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
  // Hooks called as events fire — wired through to the runner EventBus by
  // the caller. The runner's `agent()` primitive is responsible for emitting
  // the bus-level events; this layer is purely the per-call mechanics.
  onSessionAssigned: (sessionID: string, messageID: string) => void;
  onTokenDelta: (partID: string, ordinal: number, delta: string) => void;
  onReasoningDelta: (partID: string, ordinal: number, delta: string) => void;
  onToolStart: (call: import("./SessionTracker.ts").AssembledToolCall) => void;
  onToolResult: (call: import("./SessionTracker.ts").AssembledToolCall) => void;
  onRawEvent: (evType: string, payload: unknown) => void;
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

  const result = (async (): Promise<PromptResult> => {
    const fullPrompt = req.schema
      ? `${req.prompt}\n${describeSchemaForPrompt(req.schema)}`
      : req.prompt;
    // opencode's prompt_async API requires messageID to start with "msg"
    // (validation error: "Expected a string starting with \"msg\"").
    const messageID = `msg_${uuid().replace(/-/g, "")}`;
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
    req.onSessionAssigned(sessionID, messageID);

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

    timer = setTimeout(() => {
      tracker?.markTimeout();
    }, req.timeoutMs);

    try {
      await server.sendPromptAsync(sessionID, {
        messageID,
        model: req.model,
        agent: req.agent,
        tools: req.tools,
        text: fullPrompt,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (tracker) server.unregisterTracker(tracker);
      return {
        ok: false,
        reason: "http",
        message: (err as Error).message,
        rawText: "",
        elapsedMs: Date.now() - t0,
      };
    }

    await idleP;
    if (timer) clearTimeout(timer);
    server.unregisterTracker(tracker!);

    const rawText = tracker!.finalText();
    const reason = tracker!.reason();
    const elapsedMs = Date.now() - t0;

    if (aborted || reason === "abort") {
      return { ok: false, reason: "abort", rawText, elapsedMs };
    }
    if (reason === "timeout") {
      // best-effort: tell the server to stop.
      if (sessionID) await server.abortSession(sessionID);
      return { ok: false, reason: "timeout", rawText, elapsedMs };
    }
    if (reason === "error") {
      return {
        ok: false,
        reason: "internal",
        message: tracker!.errorMessage(),
        rawText,
        elapsedMs,
      };
    }
    if (reason !== "idle") {
      return { ok: false, reason: "idle", rawText, elapsedMs };
    }

    if (!req.schema) {
      return { ok: true, data: rawText.trim(), rawText, elapsedMs };
    }

    const parsed = extractJson(rawText);
    if (parsed === undefined) {
      return { ok: false, reason: "schema", message: "no parseable JSON", rawText, elapsedMs };
    }
    const validate = compileSchema(req.schema);
    const v = validate(parsed);
    if (!v.ok) {
      return { ok: false, reason: "schema", message: v.errors.join("; "), rawText, elapsedMs };
    }
    return { ok: true, data: v.data, rawText, elapsedMs };
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
