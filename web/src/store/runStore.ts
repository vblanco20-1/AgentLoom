import { create } from "zustand";
import type { RunnerEvent, WorkflowMeta } from "../api/types";

export interface TextPartState {
  partID: string;
  ordinal: number;
  text: string;
}

export interface ReasoningPartState {
  partID: string;
  ordinal: number;
  text: string;
}

export interface ToolCallState {
  callID: string;
  ordinal: number;
  tool: string;
  input: unknown;
  status: "running" | "completed" | "error";
  output?: string;
  error?: string;
  elapsedMs?: number;
}

export type TimelineItem =
  | ({ kind: "text" } & TextPartState)
  | ({ kind: "reasoning" } & ReasoningPartState)
  | ({ kind: "tool" } & ToolCallState);

export interface RawEventEntry {
  evType: string;
  payload: unknown;
  t: number;
}

export interface AgentState {
  agentId: string;
  label?: string;
  phase?: string;
  cwd: string;
  prompt: string;
  schemaHash?: string;
  // Per-part accumulation. The timeline view orders these by ordinal so
  // thinking → tool use → thinking → text shows up in arrival order.
  textParts: TextPartState[];
  reasoningParts: ReasoningPartState[];
  toolCalls: ToolCallState[];
  // Canonical full assistant text from agent.end (SessionTracker.finalText()).
  // Preferred over textParts when rendering "the final answer" since deltas
  // can occasionally drop on flaky SSE links.
  rawText?: string;
  // Every SSE event routed to this session, in arrival order. Used by the
  // raw-events panel so the long tail of part types (todo.updated,
  // file.edited, step-start/finish, snapshot, patch, retry, compaction,
  // message.updated with finish reason / token usage, etc.) is never lost.
  rawEvents: RawEventEntry[];
  status: "running" | "ok" | "fail" | "queued";
  reason?: string;
  startedAt: number;
  endedAt?: number;
  output?: unknown;
}

interface RunState {
  meta?: WorkflowMeta;
  workflowPath?: string;
  startedAt?: number;
  endedAt?: number;
  ok?: boolean;
  result?: unknown;
  error?: { message: string; stack?: string };
  activePhase?: string;
  phases: string[];
  agents: Record<string, AgentState>;
  agentOrder: string[];
  log: Array<{ msg: string; t: number; meta?: unknown }>;

  apply(ev: RunnerEvent): void;
  reset(): void;
}

const initial = (): Pick<RunState, "phases" | "agents" | "agentOrder" | "log"> => ({
  phases: [],
  agents: {},
  agentOrder: [],
  log: [],
});

export const useRun = create<RunState>((set) => ({
  ...initial(),
  reset: () => set(() => ({ ...initial(), meta: undefined, workflowPath: undefined, startedAt: undefined, endedAt: undefined, ok: undefined, result: undefined, error: undefined, activePhase: undefined })),
  apply: (ev) => set((s) => {
    switch (ev.kind) {
      case "workflow.start":
        return { ...s, meta: ev.meta, workflowPath: ev.workflowPath, startedAt: ev.t, phases: ev.meta?.phases?.map((p) => p.title) ?? [] };
      case "workflow.end":
        return { ...s, endedAt: ev.t, ok: ev.ok, result: ev.result, error: ev.error };
      case "workflow.log":
        return { ...s, log: [...s.log, { msg: ev.msg, t: ev.t, meta: ev.meta }] };
      case "phase.mark":
        return { ...s, activePhase: ev.title };
      case "agent.start": {
        const a: AgentState = {
          agentId: ev.agentId,
          label: ev.label,
          phase: ev.phase,
          cwd: ev.cwd,
          prompt: ev.prompt,
          schemaHash: ev.schemaHash,
          textParts: [],
          reasoningParts: [],
          toolCalls: [],
          rawEvents: [],
          status: "running",
          startedAt: ev.t,
        };
        return {
          ...s,
          agents: { ...s.agents, [ev.agentId]: a },
          agentOrder: [...s.agentOrder, ev.agentId],
        };
      }
      case "agent.token": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        const idx = a.textParts.findIndex((p) => p.partID === ev.partID);
        const next = idx >= 0
          ? a.textParts.map((p, i) => i === idx ? { ...p, text: p.text + ev.delta } : p)
          : [...a.textParts, { partID: ev.partID, ordinal: ev.ordinal, text: ev.delta }];
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, textParts: next } } };
      }
      case "agent.reasoning": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        const idx = a.reasoningParts.findIndex((p) => p.partID === ev.partID);
        const next = idx >= 0
          ? a.reasoningParts.map((p, i) => i === idx ? { ...p, text: p.text + ev.delta } : p)
          : [...a.reasoningParts, { partID: ev.partID, ordinal: ev.ordinal, text: ev.delta }];
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, reasoningParts: next } } };
      }
      case "agent.raw": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        // Drop the high-volume streaming-token events — they fire per-token
        // and dominate the raw log while carrying no information the
        // structured timeline doesn't already render.
        if (ev.evType === "message.part.updated" || ev.evType === "message.part.delta") return s;
        // Cap per-agent ring at 2,000 entries.
        const next = a.rawEvents.length >= 2000
          ? [...a.rawEvents.slice(-1999), { evType: ev.evType, payload: ev.payload, t: ev.t }]
          : [...a.rawEvents, { evType: ev.evType, payload: ev.payload, t: ev.t }];
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, rawEvents: next } } };
      }
      case "agent.tool.start": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        const call: ToolCallState = { callID: ev.callID, ordinal: ev.ordinal, tool: ev.tool, input: ev.input, status: "running" };
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, toolCalls: [...a.toolCalls, call] } } };
      }
      case "agent.tool.result": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        const updated = a.toolCalls.map((c) => c.callID === ev.callID ? {
          ...c,
          status: ev.status,
          output: ev.output,
          error: ev.error,
          elapsedMs: ev.elapsedMs,
        } : c);
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, toolCalls: updated } } };
      }
      case "agent.end": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        return {
          ...s,
          agents: {
            ...s.agents,
            [ev.agentId]: {
              ...a,
              status: ev.ok ? "ok" : "fail",
              reason: ev.reason,
              endedAt: ev.t,
              output: ev.output,
              rawText: ev.rawText,
            },
          },
        };
      }
      default:
        return s;
    }
  }),
}));

// Merge the three per-part streams into an ordinal-sorted timeline so the
// viewer can render thinking → tool → thinking → text in the order opencode
// produced them.
export function timelineFor(a: AgentState): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const p of a.textParts) items.push({ kind: "text", ...p });
  for (const p of a.reasoningParts) items.push({ kind: "reasoning", ...p });
  for (const c of a.toolCalls) items.push({ kind: "tool", ...c });
  items.sort((x, y) => x.ordinal - y.ordinal);
  return items;
}

// Convenience helper for components that just want the concatenated assistant
// text (TranscriptModal's "Full LLM output" pane, etc.). Prefer rawText when
// agent.end has fired so flaky-SSE drops don't show truncated output.
export function fullText(a: AgentState): string {
  if (a.rawText && a.rawText.length > 0) return a.rawText;
  return [...a.textParts].sort((x, y) => x.ordinal - y.ordinal).map((p) => p.text).join("");
}

export function fullReasoning(a: AgentState): string {
  return [...a.reasoningParts].sort((x, y) => x.ordinal - y.ordinal).map((p) => p.text).join("");
}
