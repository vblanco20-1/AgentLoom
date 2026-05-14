import type { EventBus } from "../bus/EventBus.ts";
import type { RunnerEvent } from "../bus/events.ts";

export interface WsClient {
  send(msg: string): void;
  readyState: number;
}

type Sub = { runId: string; client: WsClient };

export class WsHub {
  private subs = new Set<Sub>();
  private unsub: (() => void) | null = null;

  attach(bus: EventBus): void {
    if (this.unsub) return;
    this.unsub = bus.on((ev) => {
      const payload = JSON.stringify({ type: "event", event: ev });
      for (const sub of this.subs) {
        if (sub.runId === ev.runId) {
          this.safeSend(sub.client, payload);
        }
      }
    });
  }

  detach(): void {
    if (this.unsub) this.unsub();
    this.unsub = null;
  }

  subscribe(client: WsClient, runId: string): () => void {
    const sub: Sub = { client, runId };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  broadcastToRun(runId: string, payload: unknown): void {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const sub of this.subs) {
      if (sub.runId === runId) {
        this.safeSend(sub.client, text);
      }
    }
  }

  private safeSend(client: WsClient, text: string): void {
    if (client.readyState !== 1) return;
    try {
      client.send(text);
    } catch {
      // ignore
    }
  }
}

export function eventMatchesRun(ev: RunnerEvent, runId: string): boolean {
  return ev.runId === runId;
}
