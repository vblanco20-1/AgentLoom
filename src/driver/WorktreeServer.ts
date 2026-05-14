import {
  createOpencodeServer,
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { Event } from "@opencode-ai/sdk/v2";
import { SessionTracker, type AssembledToolCall } from "./SessionTracker.ts";

export interface WorktreeServerOptions {
  cwd: string;
  hostname: string;
  bootTimeoutMs: number;
  extraConfig?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
}

export class WorktreeServer {
  readonly cwd: string;
  private url: string | null = null;
  private close: (() => void) | null = null;
  // We use the v2 SDK for everything: it ships native typed `format`
  // support on prompt_async (json_schema enforcement) and a v2 Event union
  // that includes message.part.delta — no more pretending v1 has it.
  private client: OpencodeClient | null = null;
  private trackersBySession = new Map<string, SessionTracker>();
  private trackersByMessage = new Map<string, SessionTracker>();
  private sseAbort: AbortController | null = null;
  private boundOnce = false;
  private booted = false;
  private bootPromise: Promise<void> | null = null;
  private opts: WorktreeServerOptions;

  constructor(opts: WorktreeServerOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
  }

  baseUrl(): string {
    if (!this.url) throw new Error("WorktreeServer not booted");
    return this.url;
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.bootInner();
    return this.bootPromise;
  }

  private async bootInner(): Promise<void> {
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), this.opts.bootTimeoutMs);
    let server: { url: string; close(): void };
    try {
      server = await createOpencodeServer({
        hostname: this.opts.hostname,
        port: 0,
        signal: ac.signal,
        // SDK uses setTimeout(fn, timeout) literally, so passing 0 fires the
        // timeout before opencode can boot. Use the configured bootTimeoutMs
        // (still belt-and-suspendered by our own AbortController above).
        timeout: this.opts.bootTimeoutMs,
        config: {
          ...(this.opts.extraConfig ?? {}),
          ...(this.opts.mcp ? { mcp: this.opts.mcp as Record<string, unknown> } : {}),
        } as never,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    this.url = server.url;
    this.close = server.close;
    this.client = createOpencodeClient({ baseUrl: server.url });
    this.booted = true;
    // Subscribe to SSE event stream via the SDK (handles retry/backoff
    // internally; the raw /event endpoint behavior changed in newer opencode
    // versions — using the SDK client routes to /global/event correctly).
    this.startSse();
  }

  private startSse(): void {
    this.sseAbort = new AbortController();
    void this.ssePumpLoop(this.sseAbort.signal);
  }

  private async ssePumpLoop(signal: AbortSignal): Promise<void> {
    // Defensive outer loop: if the SDK stream ever ends cleanly, give the
    // server a moment to settle before resubscribing. Without this, a
    // server-side close becomes a tight reconnect storm that blows up
    // opencode's log file (we saw ~90 MB in 80s on the first bug encounter).
    while (!signal.aborted && this.booted) {
      const startedAt = Date.now();
      try {
        await this.ssePumpOnce(signal);
      } catch (err) {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      const elapsed = Date.now() - startedAt;
      const delay = elapsed < 250 ? 1000 : 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private async ssePumpOnce(signal: AbortSignal): Promise<void> {
    if (!this.client) throw new Error("WorktreeServer.client not initialized");
    // IMPORTANT: opencode's /event endpoint only emits the server.connected
    // welcome and immediately closes. The real LLM event stream lives at
    // /global/event (yields message.part.delta, message.part.updated,
    // session.idle, etc). The v2 SDK's client.global.event() hits the right
    // URL; v2's client.event.subscribe() hits the wrong (welcome-only) one
    // and must not be used here.
    // Events on /global/event are wrapped in { directory, project, payload }
    // — dispatchEvent unwraps .payload before routing to SessionTracker.
    const result = await this.client.global.event({ signal });
    const stream = (result as { stream: AsyncGenerator<unknown> }).stream as AsyncGenerator<Event>;
    try {
      for await (const ev of stream) {
        if (signal.aborted) return;
        try {
          this.dispatchEvent(ev);
        } catch {
          // dispatch failure must not kill the stream
        }
      }
    } finally {
      // Best-effort early termination of the underlying response stream.
      try {
        await (stream as AsyncGenerator<Event>).return?.(undefined);
      } catch {
        // ignore
      }
    }
  }

  private dispatchEvent(raw: unknown): void {
    // /global/event events look like:
    //   { directory, project, payload: { id, type, properties } }
    // OR for sync-mirror events:
    //   { directory, project, payload: { type: "sync", syncEvent: {...} } }
    // Unwrap payload; ignore sync mirrors (they are duplicates of the real
    // events that already passed through this dispatcher).
    const wrapper = raw as { payload?: unknown };
    const payload = wrapper && wrapper.payload != null ? wrapper.payload : raw;
    const ev = payload as Event;
    const evType = (ev as { type?: string }).type;
    if (evType === "sync") return;

    // Route to the relevant tracker by sessionID first.
    const sessionID = extractSessionID(ev);
    if (sessionID) {
      const t = this.trackersBySession.get(sessionID);
      if (t) {
        t.handle(ev);
        return;
      }
    }
    // Some events only carry messageID — route via that.
    const messageID = extractMessageID(ev);
    if (messageID) {
      const t = this.trackersByMessage.get(messageID);
      if (t) t.handle(ev);
    }
  }

  registerTracker(t: SessionTracker): void {
    this.trackersBySession.set(t.sessionID, t);
    this.trackersByMessage.set(t.messageID, t);
  }

  unregisterTracker(t: SessionTracker): void {
    this.trackersBySession.delete(t.sessionID);
    this.trackersByMessage.delete(t.messageID);
  }

  async createSession(): Promise<string> {
    if (!this.client) throw new Error("WorktreeServer.client not initialized");
    const res = await this.client.session.create({ directory: this.cwd });
    // The SDK's request helpers return `{ data, error, response }`.
    const data = (res as { data?: { id?: string }; error?: unknown }).data;
    const error = (res as { error?: unknown }).error;
    if (!data?.id) {
      const msg = error
        ? typeof error === "string"
          ? error
          : JSON.stringify(error)
        : "createSession: missing data.id in SDK response";
      throw new Error(`createSession: ${msg}`);
    }
    return data.id;
  }

  async sendPromptAsync(
    sessionID: string,
    body: {
      messageID: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      tools?: Record<string, boolean>;
      text: string;
      // Schema to enforce server-side via opencode's structured-output mode.
      // When provided, opencode 1.14+ binds the model's native JSON mode (or
      // re-prompts up to retryCount times if the response misses the schema)
      // — drastically more reliable than relying on the model to read our
      // describeSchemaForPrompt block.
      schema?: Record<string, unknown>;
      schemaRetryCount?: number;
    },
  ): Promise<void> {
    if (!this.client) throw new Error("WorktreeServer.client not initialized");
    // v2's promptAsync takes a flat params object. `format: OutputFormat`
    // binds opencode's native structured-output enforcement: the model is
    // constrained to a JSON object matching `schema`, and opencode re-prompts
    // up to retryCount times if a reply violates it before surfacing the
    // error.
    const params: Parameters<OpencodeClient["session"]["promptAsync"]>[0] = {
      sessionID,
      directory: this.cwd,
      messageID: body.messageID,
      parts: [{ type: "text", text: body.text }],
    };
    if (body.model) params.model = body.model;
    if (body.agent) params.agent = body.agent;
    if (body.tools) params.tools = body.tools;
    if (body.schema) {
      params.format = {
        type: "json_schema",
        schema: body.schema,
        retryCount: body.schemaRetryCount ?? 2,
      };
    }
    const res = await this.client.session.promptAsync(params);
    const error = (res as { error?: unknown }).error;
    if (error) {
      const msg = typeof error === "string" ? error : JSON.stringify(error);
      throw new Error(`prompt_async: ${msg}`);
    }
  }

  async abortSession(sessionID: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.session.abort({ sessionID, directory: this.cwd });
    } catch {
      // best-effort
    }
  }

  shutdown(): void {
    if (this.sseAbort) this.sseAbort.abort();
    if (this.close) {
      try {
        this.close();
      } catch {
        // ignore
      }
    }
    this.booted = false;
    this.client = null;
  }
}

function extractSessionID(ev: Event): string | undefined {
  const p = (ev as { properties?: Record<string, unknown> }).properties;
  if (!p) return undefined;
  if (typeof p.sessionID === "string") return p.sessionID;
  // For part-updated events the session ID is nested.
  const part = (p as { part?: { sessionID?: string } }).part;
  if (part && typeof part.sessionID === "string") return part.sessionID;
  const info = (p as { info?: { id?: string } }).info;
  if (info && typeof info.id === "string") return info.id;
  return undefined;
}

function extractMessageID(ev: Event): string | undefined {
  const p = (ev as { properties?: Record<string, unknown> }).properties;
  if (!p) return undefined;
  if (typeof p.messageID === "string") return p.messageID;
  const part = (p as { part?: { messageID?: string } }).part;
  if (part && typeof part.messageID === "string") return part.messageID;
  return undefined;
}

// Keep this exported for tests / future ToolStateError introspection.
export type { AssembledToolCall };
