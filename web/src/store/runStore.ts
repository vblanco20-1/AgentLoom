import { create } from "zustand";
import type { RunnerEvent, WorkflowMeta } from "../api/types";

export interface AgentState {
  agentId: string;
  label?: string;
  phase?: string;
  cwd: string;
  prompt: string;
  schemaHash?: string;
  text: string; // accumulated tokens
  toolCalls: ToolCallState[];
  status: "running" | "ok" | "fail" | "queued";
  reason?: string;
  startedAt: number;
  endedAt?: number;
  output?: unknown;
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
          toolCalls: [],
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
        return { ...s, agents: { ...s.agents, [ev.agentId]: { ...a, status: ev.ok ? "ok" : "fail", reason: ev.reason, endedAt: ev.t, output: ev.output } } };
      }
      default:
        return s;
    }
  }),
}));
