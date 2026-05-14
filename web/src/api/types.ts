// Mirror of agent_runner/src/bus/events.ts kept in sync by hand.
// React layer only reads these; canonical types live server-side.

export type AgentEndReason =
  | "ok" | "schema" | "abort" | "http" | "timeout" | "idle" | "boot" | "internal";

export type ToolStatus = "completed" | "error";

export interface WorkflowMeta {
  name: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export type RunnerEvent =
  | { kind: "workflow.start"; runId: string; workflowPath: string; meta: WorkflowMeta; args: unknown; t: number }
  | { kind: "workflow.end"; runId: string; ok: boolean; result?: unknown; error?: { message: string; stack?: string }; t: number }
  | { kind: "workflow.log"; runId: string; msg: string; meta?: unknown; t: number }
  | { kind: "phase.mark"; runId: string; title: string; t: number }
  | { kind: "agent.start"; runId: string; agentId: string; label?: string; phase?: string; cwd: string; prompt: string; schemaHash?: string; t: number }
  | { kind: "agent.session"; runId: string; agentId: string; sessionID: string; messageID: string; t: number }
  | { kind: "agent.token"; runId: string; agentId: string; partID: string; ordinal: number; delta: string; t: number }
  | { kind: "agent.reasoning"; runId: string; agentId: string; partID: string; ordinal: number; delta: string; t: number }
  | { kind: "agent.tool.start"; runId: string; agentId: string; callID: string; ordinal: number; tool: string; input: unknown; t: number }
  | { kind: "agent.tool.result"; runId: string; agentId: string; callID: string; tool: string; status: ToolStatus; output?: string; error?: string; elapsedMs: number; t: number }
  | { kind: "agent.raw"; runId: string; agentId: string; evType: string; payload: unknown; t: number }
  | { kind: "agent.schemaRetry"; runId: string; agentId: string; attempt: number; maxRetries: number; error: string; t: number }
  | { kind: "agent.end"; runId: string; agentId: string; ok: boolean; reason: AgentEndReason; output?: unknown; rawText?: string; elapsedMs: number; t: number };

export interface RunIndexEntry {
  runId: string;
  meta: {
    workflowPath?: string;
    workflowName?: string;
    workflowDescription?: string;
    startedAt?: number;
  };
  result: { ok?: boolean; error?: { message: string } } | null;
  hasEvents: boolean;
  mtimeMs: number;
}
