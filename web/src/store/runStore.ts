import { create } from "zustand";
import type { RunnerEvent, WorkflowMeta } from "../api/types";

export interface AgentState {
  agentId: string;
  label?: string;
  phase?: string;
  cwd: string;
  prompt: string;
  schemaHash?: string;
  text: string; // accumulated assistant text — replaced with canonical rawText on agent.end
  rawText?: string; // canonical full assistant text from agent.end
  reasoning: string; // accumulated model "thinking" deltas (opencode reasoning parts)
  toolCalls: ToolCallState[];
  rawEvents: RawEventEntry[]; // every SSE event from opencode for this session, in arrival order
  status: "running" | "ok" | "fail" | "queued";
  reason?: string;
  startedAt: number;
  endedAt?: number;
  output?: unknown;
}

export interface RawEventEntry {
  evType: string;
  payload: unknown;
  t: number;
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
          text: "",
          reasoning: "",
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
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, text: a.text + ev.delta } } };
      }
      case "agent.reasoning": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, reasoning: a.reasoning + ev.delta } } };
      }
      case "agent.raw": {
        const a = s.agents[ev.agentId];
        if (!a) return s;
        // Cap per-agent ring at 2,000 entries — message.part.updated fires
        // on every token tick and a 30-min run can produce hundreds of
        // thousands of events; storing them all in zustand will OOM the tab.
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
        // Canonical full LLM text from the SessionTracker's finalText() —
        // backfill the streamed `text` so the UI shows the complete output
        // even if any deltas were dropped, and stash it separately for the
        // transcript view.
        const raw = ev.rawText;
        const text = raw && raw.length > a.text.length ? raw : a.text;
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
              rawText: raw,
              text,
            },
          },
        };
      }
      default:
        return s;
    }
  }),
}));
