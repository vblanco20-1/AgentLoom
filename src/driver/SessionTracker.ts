// Per-session state assembly from the multiplexed /event SSE stream.
// One tracker is created per agent() call, registered with the WorktreeServer
// under both sessionID and messageID for routing.

import type { Event } from "@opencode-ai/sdk/v2";

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
  // Emitted-so-far length keyed by partID — the streaming counter we use to
  // dedupe between message.part.delta (incremental) and message.part.updated
  // (snapshot of full text). When a snapshot arrives, anything beyond
  // textLen[partID] is the new tail to emit; everything before was already
  // streamed via deltas. Same trick for reasoning.
  private textLen = new Map<string, number>();
  private reasoningLen = new Map<string, number>();
  private toolCalls = new Map<string, AssembledToolCall>();
  // Final assembled assistant text, in part-ordinal order.
  private textParts = new Map<string, AssembledText>();
  // Final assembled reasoning text, in part-ordinal order.
  private reasoningParts = new Map<string, AssembledText>();
  // Once we've seen a message.part.updated for a partID we know its kind
  // ("text" vs "reasoning"). message.part.delta carries the partID but its
  // `field` doesn't disambiguate (both TextPart and ReasoningPart stream
  // into a field called "text"). So we use this map to route the delta.
  private partKinds = new Map<string, "text" | "reasoning">();
  // Deltas that arrived before we knew the part's kind — opencode often
  // emits message.part.delta tokens before the first message.part.updated
  // snapshot for that partID. Buffer them in arrival order and flush on the
  // first matching .updated event.
  private pendingDeltas = new Map<string, string[]>();
  // partIDs that belong to the user-prompt echo, so we keep skipping their
  // deltas after the initial .updated tagged them.
  private userEchoParts = new Set<string>();
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
    // opencode v2 emits message.part.delta as the primary streaming token
    // event — often BEFORE the first message.part.updated snapshot for the
    // same partID arrives. The SDK v1 Event union doesn't list this type, so
    // we branch on the raw string before entering the typed switch. Three
    // cases:
    //   1. partID already known to be the user echo → drop.
    //   2. kind ("text" | "reasoning") known from a prior .updated → route now.
    //   3. kind unknown → buffer; first matching .updated flushes via
    //      flushPendingForText/Reasoning before processing the snapshot.
    const evType = (ev as { type?: string }).type;
    if (evType === "message.part.delta") {
      this.handlePartDelta(ev as unknown as { properties: { sessionID?: string; messageID?: string; partID?: string; field?: string; delta?: string } });
      return;
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
          if (part.messageID === this.messageID) {
            this.userEchoParts.add(part.id);
            // Drop any deltas we'd buffered for this part before we knew it
            // was the user echo — they would re-emit the user prompt as
            // assistant tokens.
            this.pendingDeltas.delete(part.id);
            return;
          }
          const ordinal = this.ordinalFor(part.id);
          if (part.type === "text") {
            this.partKinds.set(part.id, "text");
            this.flushPendingForText(part.id, ordinal);
            const prev = this.textLen.get(part.id) ?? 0;
            const text = part.text ?? "";
            // Compute the tail beyond what we already streamed. Anything up
            // to `prev` was already emitted (via prior .delta tokens or an
            // earlier snapshot); the slice after is the new tail.
            const tail = text.slice(prev);
            this.textLen.set(part.id, text.length);
            this.textParts.set(part.id, {
              partID: part.id,
              ordinal,
              text,
            });
            if (tail.length > 0) {
              this.cb.onTokenDelta(part.id, ordinal, tail);
            }
          } else if (part.type === "reasoning") {
            // Model "thinking" stream — same flush-then-tail dance as text.
            this.partKinds.set(part.id, "reasoning");
            this.flushPendingForReasoning(part.id, ordinal);
            const prev = this.reasoningLen.get(part.id) ?? 0;
            const text = part.text ?? "";
            const tail = text.slice(prev);
            this.reasoningLen.set(part.id, text.length);
            this.reasoningParts.set(part.id, {
              partID: part.id,
              ordinal,
              text,
            });
            if (tail.length > 0) {
              this.cb.onReasoningDelta(part.id, ordinal, tail);
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
          // Last-chance flush: if opencode streamed text via message.part.delta
          // and never followed up with a message.part.updated snapshot, the
          // buffered deltas would otherwise vanish — leaving finalText()
          // empty and breaking JSON-schema validation on the runner side.
          // Treat any leftover pending parts as text (the dominant case);
          // reasoning-only parts without a snapshot are uncommon.
          this.flushAllPendingAsText();
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

  private handlePartDelta(ev: { properties: { sessionID?: string; messageID?: string; partID?: string; field?: string; delta?: string } }): void {
    const p = ev.properties;
    if (!p.partID) return;
    if (p.messageID && p.messageID === this.messageID) {
      this.userEchoParts.add(p.partID);
      this.pendingDeltas.delete(p.partID);
      return;
    }
    if (this.userEchoParts.has(p.partID)) return;
    const delta = p.delta ?? "";
    if (delta.length === 0) return;
    const kind = this.partKinds.get(p.partID);
    if (kind === "text") {
      this.appendTextDelta(p.partID, delta);
    } else if (kind === "reasoning") {
      this.appendReasoningDelta(p.partID, delta);
    } else {
      let buf = this.pendingDeltas.get(p.partID);
      if (!buf) { buf = []; this.pendingDeltas.set(p.partID, buf); }
      buf.push(delta);
    }
  }

  // Append a text delta to the partID's internal buffer, advance textLen, and
  // notify the consumer. Used by both message.part.delta (streaming tokens)
  // and the flush path after a .updated tags the partID's kind.
  private appendTextDelta(partID: string, delta: string): void {
    const ordinal = this.ordinalFor(partID);
    const prev = this.textParts.get(partID);
    const text = (prev?.text ?? "") + delta;
    this.textParts.set(partID, { partID, ordinal, text });
    this.textLen.set(partID, text.length);
    this.cb.onTokenDelta(partID, ordinal, delta);
  }

  private appendReasoningDelta(partID: string, delta: string): void {
    const ordinal = this.ordinalFor(partID);
    const prev = this.reasoningParts.get(partID);
    const text = (prev?.text ?? "") + delta;
    this.reasoningParts.set(partID, { partID, ordinal, text });
    this.reasoningLen.set(partID, text.length);
    this.cb.onReasoningDelta(partID, ordinal, delta);
  }

  // Replay any deltas we buffered before the first .updated told us this
  // partID was a text part. Re-uses appendTextDelta so the internal
  // accumulators and the consumer callback both stay consistent.
  private flushPendingForText(partID: string, _ordinal: number): void {
    const buf = this.pendingDeltas.get(partID);
    if (!buf || buf.length === 0) return;
    this.pendingDeltas.delete(partID);
    for (const d of buf) this.appendTextDelta(partID, d);
  }

  private flushPendingForReasoning(partID: string, _ordinal: number): void {
    const buf = this.pendingDeltas.get(partID);
    if (!buf || buf.length === 0) return;
    this.pendingDeltas.delete(partID);
    for (const d of buf) this.appendReasoningDelta(partID, d);
  }

  // Catch-all flush invoked on session.idle. Any partIDs that still have
  // buffered deltas at this point never received a message.part.updated
  // snapshot to tag their kind — almost always text, because reasoning
  // streams reliably get snapshots. Routing as text means finalText() will
  // contain the assistant output (and any JSON inside it).
  private flushAllPendingAsText(): void {
    if (this.pendingDeltas.size === 0) return;
    for (const [partID, buf] of this.pendingDeltas) {
      this.partKinds.set(partID, "text");
      for (const d of buf) this.appendTextDelta(partID, d);
    }
    this.pendingDeltas.clear();
  }
}
