import type { RunnerEvent } from "./types";

export interface WsClientHandlers {
  onEvent: (ev: RunnerEvent) => void;
  onClose?: () => void;
  onError?: () => void;
}

export class RunWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WsClientHandlers;

  constructor(runId: string, handlers: WsClientHandlers) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${location.host}/ws/run/${encodeURIComponent(runId)}`;
    this.handlers = handlers;
  }

  open(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "event" && msg.event) this.handlers.onEvent(msg.event);
      } catch {
        // ignore
      }
    };
    this.ws.onclose = () => this.handlers.onClose?.();
    this.ws.onerror = () => this.handlers.onError?.();
  }

  abortAll(): void {
    this.ws?.send(JSON.stringify({ type: "abort" }));
  }

  abortAgent(agentId: string): void {
    this.ws?.send(JSON.stringify({ type: "abort-agent", agentId }));
  }

  close(): void {
    this.ws?.close();
  }
}
