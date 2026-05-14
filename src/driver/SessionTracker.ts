// Per-session state assembly from the multiplexed /event SSE stream.
// One tracker is created per agent() call, registered with the WorktreeServer
// under both sessionID and messageID for routing.

import type { Event } from "@opencode-ai/sdk";

export type EndReason =
  | "idle"        // EventSessionIdle reached
  | "error"       // EventSessionError received
  | "abort"       // we called DELETE /session/:id/abort
  | "timeout"     // our agentTimeoutMs elapsed
  | "internal";   // unexpected exception in the tracker

export interface AssembledText {
  partID: string;
  ordinal: number;
  text: string;
}

export interface AssembledToolCall {
  callID: string;
  partID: string;
  ordinal: number;
  tool: string;
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  startMs: number;
  endMs?: number;
  // Whether we've already emitted the .start event (gating)
  startEmitted: boolean;
  // Whether we've already emitted the .result event (gating)
  resultEmitted: boolean;
}

export interface TrackerCallbacks {
  onTokenDelta: (partID: string, ordinal: number, delta: string) => void;
  onReasoningDelta: (partID: string, ordinal: number, delta: string) => void;
  onToolStart: (call: AssembledToolCall) => void;
  onToolResult: (call: AssembledToolCall) => void;
  onSessionIdle: () => void;
  onSessionError: (msg: string) => void;
  // Catch-all — fires for EVERY event routed to this tracker, regardless of
  // whether a specific handler exists. Lets the UI surface unhandled part
  // types (subtask / file / step-start / step-finish / snapshot / patch /
  // agent / retry / compaction), as well as todo.updated, file.edited,
  // session.status, etc., without losing anything to the default branch.
  onRawEvent: (evType: string, payload: unknown) => void;
}

export class SessionTracker {
  readonly sessionID: string;
  readonly messageID: string;
  private partOrdinal = 0;
  private partOrdinals = new Map<string, number>();
  // Last text-part length keyed by partID — to derive a delta when only
  // .text full content is delivered (some opencode builds send no `delta`).
  private textLen = new Map<string, number>();
  // Same trick for reasoning parts (model "thinking" stream).
  private reasoningLen = new Map<string, number>();
  private toolCalls = new Map<string, AssembledToolCall>();
  // Final assembled assistant text, in part-ordinal order.
  private textParts = new Map<string, AssembledText>();
  // Final assembled reasoning text, in part-ordinal order.
  private reasoningParts = new Map<string, AssembledText>();
  private done = false;
  private endReason: EndReason | null = null;
  private endMessage = "";
  private cb: TrackerCallbacks;

  constructor(
    sessionID: string,
    messageID: string,
    cb: TrackerCallbacks,
  ) {
    this.sessionID = sessionID;
    this.messageID = messageID;
    this.cb = cb;
  }

  isDone(): boolean {
    return this.done;
  }

  reason(): EndReason | null {
    return this.endReason;
  }

  errorMessage(): string {
    return this.endMessage;
  }

  finalText(): string {
    return [...this.textParts.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((p) => p.text)
      .join("");
  }

  finalReasoning(): string {
    return [...this.reasoningParts.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((p) => p.text)
      .join("");
  }

  markAbort(): void {
    if (this.done) return;
    this.done = true;
    this.endReason = "abort";
  }

  markTimeout(): void {
    if (this.done) return;
    this.done = true;
    this.endReason = "timeout";
  }

  markInternal(msg: string): void {
    if (this.done) return;
    this.done = true;
    this.endReason = "internal";
    this.endMessage = msg;
  }

  handle(ev: Event): void {
    if (this.done) return;
    // Surface every event to the bus FIRST so the UI can render even types
    // we don't otherwise model. The specific switch below still runs and
    // fires the structured callbacks (text/reasoning/tool/idle/error).
    try {
      const properties = (ev as { properties?: unknown }).properties;
      this.cb.onRawEvent(ev.type, properties);
    } catch {
      // never let the raw firehose break the structured pipeline
    }
    try {
      switch (ev.type) {
        case "message.part.updated": {
          const part = ev.properties.part;
          // this.messageID is the id we generated client-side for the USER
          // prompt; opencode echoes the user message back as a message.part
          // with that id, and creates a SEPARATE server-generated message
          // for the assistant reply. Skip our own user echo; accept every
          // other part in this session (assistant + any subsequent steps).
          // Dispatcher already filtered to this session via sessionID, so
          // we won't see cross-session parts here.
          if (part.messageID === this.messageID) return;
          const ordinal = this.ordinalFor(part.id);
          if (part.type === "text") {
            const prev = this.textLen.get(part.id) ?? 0;
            const text = part.text ?? "";
            // Prefer SDK-supplied delta when present; else compute it.
            const delta = ev.properties.delta ?? text.slice(prev);
            this.textLen.set(part.id, text.length);
            this.textParts.set(part.id, {
              partID: part.id,
              ordinal,
              text,
            });
            if (delta.length > 0) {
              this.cb.onTokenDelta(part.id, ordinal, delta);
            }
          } else if (part.type === "reasoning") {
            // Model "thinking" stream — same delta-or-diff dance as text.
            const prev = this.reasoningLen.get(part.id) ?? 0;
            const text = part.text ?? "";
            const delta = ev.properties.delta ?? text.slice(prev);
            this.reasoningLen.set(part.id, text.length);
            this.reasoningParts.set(part.id, {
              partID: part.id,
              ordinal,
              text,
            });
            if (delta.length > 0) {
              this.cb.onReasoningDelta(part.id, ordinal, delta);
            }
          } else if (part.type === "tool") {
            const existing = this.toolCalls.get(part.callID);
            const status = part.state.status;
            const startMs = "time" in part.state && part.state.time?.start
              ? part.state.time.start
              : existing?.startMs ?? Date.now();
            const endMs = "time" in part.state && "end" in part.state.time
              ? part.state.time.end
              : undefined;
            const input = "input" in part.state ? part.state.input : existing?.input;
            const output = part.state.status === "completed" ? part.state.output : existing?.output;
            const errStr = part.state.status === "error" ? part.state.error : existing?.error;
            const call: AssembledToolCall = existing ?? {
              callID: part.callID,
              partID: part.id,
              ordinal,
              tool: part.tool,
              status,
              input,
              output,
              error: errStr,
              startMs,
              endMs,
              startEmitted: false,
              resultEmitted: false,
            };
            call.status = status;
            call.tool = part.tool;
            call.input = input;
            call.output = output;
            call.error = errStr;
            call.endMs = endMs;
            this.toolCalls.set(part.callID, call);
            if (!call.startEmitted && (status === "running" || status === "pending" || status === "completed" || status === "error")) {
              call.startEmitted = true;
              this.cb.onToolStart(call);
            }
            if (!call.resultEmitted && (status === "completed" || status === "error")) {
              call.resultEmitted = true;
              this.cb.onToolResult(call);
            }
          }
          break;
        }
        case "session.idle": {
          if (ev.properties.sessionID !== this.sessionID) return;
          this.done = true;
          this.endReason = "idle";
          this.cb.onSessionIdle();
          break;
        }
        case "session.error": {
          if (ev.properties.sessionID && ev.properties.sessionID !== this.sessionID) return;
          const err = ev.properties.error;
          const msg = err
            ? (typeof err === "object" && err !== null && "data" in err
                ? JSON.stringify((err as { data: unknown }).data)
                : String(err))
            : "unknown session error";
          this.done = true;
          this.endReason = "error";
          this.endMessage = msg;
          this.cb.onSessionError(msg);
          break;
        }
        default:
          // Other events (file.edited, todo.updated, etc.) are not surfaced
          // to the runner event bus in v1. They'd be useful for richer UI
          // later.
          break;
      }
    } catch (err) {
      this.markInternal((err as Error).message);
      this.cb.onSessionError((err as Error).message);
    }
  }

  private ordinalFor(partID: string): number {
    let o = this.partOrdinals.get(partID);
    if (o === undefined) {
      o = ++this.partOrdinal;
      this.partOrdinals.set(partID, o);
    }
    return o;
  }
}
