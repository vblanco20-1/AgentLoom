export type AgentEndReason =
  | "ok"
  | "schema"
  | "abort"
  | "http"
  | "timeout"
  | "idle"
  | "boot"
  | "internal";

export type ToolStatus = "completed" | "error";

// Rough conversation-size accounting attached to agent.end so the UI / log
// stores / workflows can see how much context an agent() call burned.
// Mirrors driver/SessionTracker's ConversationTokenStats — duplicated here to
// keep the event bus's type surface self-contained.
export interface AgentTokenUsage {
  inputChars: number;
  outputChars: number;
  totalChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type RunnerEvent =
  | { kind: "workflow.start"; runId: string; workflowPath: string; meta: WorkflowMeta; args: unknown; t: number }
  | { kind: "workflow.end"; runId: string; ok: boolean; result?: unknown; error?: { message: string; stack?: string }; t: number }
  | { kind: "workflow.log"; runId: string; msg: string; meta?: unknown; t: number }
  | { kind: "phase.mark"; runId: string; title: string; t: number }
  | { kind: "memory.set"; runId: string; path: string | null; t: number }
  | { kind: "agent.start"; runId: string; agentId: string; label?: string; phase?: string; cwd: string; prompt: string; schemaHash?: string; memoryPath?: string; t: number }
  | { kind: "agent.session"; runId: string; agentId: string; sessionID: string; messageID: string; t: number }
  | { kind: "agent.token"; runId: string; agentId: string; partID: string; ordinal: number; delta: string; t: number }
  | { kind: "agent.reasoning"; runId: string; agentId: string; partID: string; ordinal: number; delta: string; t: number }
  | { kind: "agent.tool.start"; runId: string; agentId: string; callID: string; ordinal: number; tool: string; input: unknown; t: number }
  | { kind: "agent.tool.result"; runId: string; agentId: string; callID: string; tool: string; status: ToolStatus; output?: string; error?: string; elapsedMs: number; t: number }
  | { kind: "agent.raw"; runId: string; agentId: string; evType: string; payload: unknown; t: number }
  | { kind: "agent.schemaRetry"; runId: string; agentId: string; attempt: number; maxRetries: number; error: string; t: number }
  | { kind: "agent.userPrompt"; runId: string; agentId: string; attempt: number; text: string; t: number }
  | { kind: "agent.end"; runId: string; agentId: string; ok: boolean; reason: AgentEndReason; output?: unknown; rawText?: string; elapsedMs: number; tokens?: AgentTokenUsage; t: number };

export interface WorkflowMeta {
  name: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export type RunnerEventKind = RunnerEvent["kind"];

export function nowMs(): number {
  return Date.now();
}
