import type { RunnerEvent } from "./events.ts";

type Listener = (ev: RunnerEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  emit(ev: RunnerEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        // A listener throwing must not break siblings; log to stderr.
        console.error("EventBus listener threw:", err);
      }
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  off(fn: Listener): void {
    this.listeners.delete(fn);
  }

  clear(): void {
    this.listeners.clear();
  }
}
