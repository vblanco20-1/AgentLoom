import { createOpencodeServer } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
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
        timeout: 0,
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
    this.booted = true;
    // Subscribe to SSE event stream.
    this.startSse();
  }

  private startSse(): void {
    this.sseAbort = new AbortController();
    void this.ssePumpLoop(this.sseAbort.signal);
  }

  private async ssePumpLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.booted) {
      try {
        await this.ssePump(signal);
      } catch (err) {
        if (signal.aborted) return;
        // brief backoff then reconnect
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async ssePump(signal: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl()}/event`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE subscribe failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. Each frame has one or more
      // "field: value" lines. We only care about the `data:` field.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const json = dataLines.join("\n");
        try {
          const ev = JSON.parse(json) as Event;
          this.dispatchEvent(ev);
        } catch {
          // ignore unparseable frames
        }
      }
    }
  }

  private dispatchEvent(ev: Event): void {
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
    const url = `${this.baseUrl()}/session?directory=${encodeURIComponent(this.cwd)}`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) throw new Error(`createSession ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async sendPromptAsync(
    sessionID: string,
    body: {
      messageID: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      tools?: Record<string, boolean>;
      text: string;
    },
  ): Promise<void> {
    const url = `${this.baseUrl()}/session/${encodeURIComponent(sessionID)}/prompt_async?directory=${encodeURIComponent(this.cwd)}`;
    const payload = {
      messageID: body.messageID,
      ...(body.model ? { model: body.model } : {}),
      ...(body.agent ? { agent: body.agent } : {}),
      ...(body.tools ? { tools: body.tools } : {}),
      parts: [{ type: "text", text: body.text }],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`prompt_async ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  async abortSession(sessionID: string): Promise<void> {
    const url = `${this.baseUrl()}/session/${encodeURIComponent(sessionID)}/abort?directory=${encodeURIComponent(this.cwd)}`;
    try {
      await fetch(url, { method: "DELETE" });
    } catch {
      // best-effort
    }
  }

  shutdown(): void {
    if (this.sseAbort) this.sseAbort.abort();
    if (this.close) this.close();
    this.booted = false;
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
