import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { EventBus } from "../bus/EventBus.ts";
import type { AgentTokenUsage, RunnerEvent } from "../bus/events.ts";

// Per-agent XML log. One file per agent() call lands under
//   <runsDir>/<runId>/agents/<agentId>.xml
// and contains the entire chat — the user prompt, reasoning, assistant text,
// tool calls (with input AND output), schema retries, and the final result —
// so the run can be reviewed as a single readable conversation rather than
// reconstructed from the run-wide events.ndjson firehose.

interface TextPart {
  kind: "text" | "reasoning";
  ordinal: number;
  partID: string;
  text: string;
}

interface ToolEntry {
  ordinal: number;
  callID: string;
  tool: string;
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  elapsedMs?: number;
}

interface SchemaRetryEntry {
  // Anchor the retry between the parts before/after it. The retry happens
  // after the previous attempt's output has fully streamed, so we tag it with
  // the highest ordinal seen so far + 0.5 — that slots it between the part
  // that just finished and the next part the model emits.
  afterOrdinal: number;
  attempt: number;
  maxRetries: number;
  error: string;
}

interface UserPromptEntry {
  // attempt=0 anchors before any assistant parts; attempt>=1 lands right
  // after its matching schemaRetry and before the next attempt's parts.
  afterOrdinal: number;
  attempt: number;
  text: string;
}

interface AgentState {
  agentId: string;
  label?: string;
  phase?: string;
  cwd: string;
  prompt: string;
  schemaHash?: string;
  memoryPath?: string;
  startedAt: number;
  sessionID?: string;
  messageID?: string;
  parts: Map<string, TextPart>;
  toolCalls: Map<string, ToolEntry>;
  schemaRetries: SchemaRetryEntry[];
  userPrompts: UserPromptEntry[];
  maxOrdinal: number;
  ended?: {
    ok: boolean;
    reason: string;
    elapsedMs: number;
    output?: unknown;
    rawText?: string;
    endedAt: number;
    tokens?: AgentTokenUsage;
  };
}

export class AgentLogStore {
  private agentsDir: string;
  private agents = new Map<string, AgentState>();
  private unsub: (() => void) | null = null;
  private closed = false;
  private inflight = new Set<Promise<void>>();

  constructor(rootDir: string, runId: string) {
    this.agentsDir = join(resolve(rootDir, runId), "agents");
  }

  async open(): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
  }

  attach(bus: EventBus): void {
    this.unsub = bus.on((ev) => this.handle(ev));
  }

  private handle(ev: RunnerEvent): void {
    if (this.closed) return;
    switch (ev.kind) {
      case "agent.start": {
        this.agents.set(ev.agentId, {
          agentId: ev.agentId,
          label: ev.label,
          phase: ev.phase,
          cwd: ev.cwd,
          prompt: ev.prompt,
          schemaHash: ev.schemaHash,
          memoryPath: ev.memoryPath,
          startedAt: ev.t,
          parts: new Map(),
          toolCalls: new Map(),
          schemaRetries: [],
          userPrompts: [],
          maxOrdinal: 0,
        });
        break;
      }
      case "agent.session": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        s.sessionID = ev.sessionID;
        s.messageID = ev.messageID;
        break;
      }
      case "agent.token": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        appendPart(s, ev.partID, ev.ordinal, "text", ev.delta);
        break;
      }
      case "agent.reasoning": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        appendPart(s, ev.partID, ev.ordinal, "reasoning", ev.delta);
        break;
      }
      case "agent.tool.start": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        const existing = s.toolCalls.get(ev.callID);
        if (existing) {
          existing.ordinal = ev.ordinal;
          existing.tool = ev.tool;
          existing.input = ev.input;
        } else {
          s.toolCalls.set(ev.callID, {
            ordinal: ev.ordinal,
            callID: ev.callID,
            tool: ev.tool,
            status: "running",
            input: ev.input,
          });
        }
        if (ev.ordinal > s.maxOrdinal) s.maxOrdinal = ev.ordinal;
        break;
      }
      case "agent.tool.result": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        const existing = s.toolCalls.get(ev.callID);
        if (existing) {
          existing.status = ev.status;
          existing.output = ev.output;
          existing.error = ev.error;
          existing.elapsedMs = ev.elapsedMs;
        } else {
          // Result-only path (shouldn't normally happen but be defensive).
          s.toolCalls.set(ev.callID, {
            ordinal: s.maxOrdinal + 1,
            callID: ev.callID,
            tool: ev.tool,
            status: ev.status,
            output: ev.output,
            error: ev.error,
            elapsedMs: ev.elapsedMs,
          });
        }
        break;
      }
      case "agent.schemaRetry": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        s.schemaRetries.push({
          afterOrdinal: s.maxOrdinal,
          attempt: ev.attempt,
          maxRetries: ev.maxRetries,
          error: ev.error,
        });
        break;
      }
      case "agent.userPrompt": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        s.userPrompts.push({
          afterOrdinal: s.maxOrdinal,
          attempt: ev.attempt,
          text: ev.text,
        });
        break;
      }
      case "agent.end": {
        const s = this.agents.get(ev.agentId);
        if (!s) break;
        s.ended = {
          ok: ev.ok,
          reason: ev.reason,
          elapsedMs: ev.elapsedMs,
          output: ev.output,
          rawText: ev.rawText,
          endedAt: ev.t,
          tokens: ev.tokens,
        };
        const p = this.flushAgent(s.agentId);
        this.inflight.add(p);
        void p.finally(() => this.inflight.delete(p));
        break;
      }
      default:
        break;
    }
  }

  private async flushAgent(agentId: string): Promise<void> {
    const s = this.agents.get(agentId);
    if (!s) return;
    this.agents.delete(agentId);
    const xml = renderXml(s);
    const path = join(this.agentsDir, `${agentId}.xml`);
    try {
      await writeFile(path, xml, "utf8");
    } catch {
      // best effort — losing a per-agent log shouldn't take down the run
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.unsub) this.unsub();
    // Drain in-flight writes from agent.end events that arrived before close.
    await Promise.allSettled([...this.inflight]);
    // Any agents that never received agent.end (interrupted runs) still get
    // a partial log so the conversation isn't lost.
    const stragglers = [...this.agents.keys()];
    await Promise.allSettled(stragglers.map((id) => this.flushAgent(id)));
  }
}

function appendPart(
  s: AgentState,
  partID: string,
  ordinal: number,
  kind: "text" | "reasoning",
  delta: string,
): void {
  const existing = s.parts.get(partID);
  if (existing) {
    existing.text += delta;
    if (ordinal > existing.ordinal) existing.ordinal = ordinal;
  } else {
    s.parts.set(partID, { kind, ordinal, partID, text: delta });
  }
  if (ordinal > s.maxOrdinal) s.maxOrdinal = ordinal;
}

function escAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function cdata(v: string): string {
  // CDATA can't contain the literal "]]>" — split it across two CDATA sections.
  return `<![CDATA[${v.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function stringifyMaybe(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
}

type Item =
  | { ord: number; kind: "text" | "reasoning"; part: TextPart }
  | { ord: number; kind: "tool"; call: ToolEntry }
  | { ord: number; kind: "retry"; retry: SchemaRetryEntry }
  | { ord: number; kind: "sentPrompt"; prompt: UserPromptEntry };

function renderXml(s: AgentState): string {
  const items: Item[] = [];
  for (const p of s.parts.values()) {
    items.push({ ord: p.ordinal, kind: p.kind, part: p });
  }
  for (const tc of s.toolCalls.values()) {
    items.push({ ord: tc.ordinal, kind: "tool", call: tc });
  }
  for (const r of s.schemaRetries) {
    // Place the retry just after the last part of the failed attempt and
    // before the first part of the next attempt.
    items.push({ ord: r.afterOrdinal + 0.5, kind: "retry", retry: r });
  }
  for (const up of s.userPrompts) {
    // attempt 0 sits before everything (parts start at ord >= 1); attempt N>=1
    // lands right after its matching schemaRetry (at afterOrdinal + 0.5).
    const ord = up.attempt === 0 ? -1 : up.afterOrdinal + 0.75;
    items.push({ ord, kind: "sentPrompt", prompt: up });
  }
  items.sort((a, b) => a.ord - b.ord);

  const end = s.ended;
  const headerAttrs: string[] = [
    `agentId="${escAttr(s.agentId)}"`,
    `cwd="${escAttr(s.cwd)}"`,
    `startedAt="${fmtTime(s.startedAt)}"`,
  ];
  if (s.label) headerAttrs.push(`label="${escAttr(s.label)}"`);
  if (s.phase) headerAttrs.push(`phase="${escAttr(s.phase)}"`);
  if (s.schemaHash) headerAttrs.push(`schemaHash="${escAttr(s.schemaHash)}"`);
  if (s.memoryPath) headerAttrs.push(`memoryPath="${escAttr(s.memoryPath)}"`);
  if (end) {
    headerAttrs.push(`endedAt="${fmtTime(end.endedAt)}"`);
    headerAttrs.push(`ok="${end.ok}"`);
    headerAttrs.push(`reason="${escAttr(end.reason)}"`);
    headerAttrs.push(`elapsedMs="${end.elapsedMs}"`);
  }

  let out = "";
  out += `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<agentLog ${headerAttrs.join(" ")}>\n`;
  if (s.sessionID || s.messageID) {
    out += `  <session sessionID="${escAttr(s.sessionID ?? "")}" messageID="${escAttr(s.messageID ?? "")}" />\n`;
  }
  // The verbatim string the workflow author passed to agent(). Kept separate
  // from the user turns below because what opencode actually receives is
  // wrapped with memoryPrefix + schema-description (and replaced wholesale
  // on retries). Reviewers can compare intent vs. delivered text.
  out += `  <workflowPrompt>${cdata(s.prompt)}</workflowPrompt>\n`;
  out += `  <conversation>\n`;
  // Walk the merged timeline, opening a <message role="user|assistant"> block
  // each time the speaker changes. Items from opencode (text/reasoning/tool)
  // belong to the assistant; sentPrompt items are the user side; schemaRetry
  // is a marker between turns and lives outside any message block.
  let openRole: "user" | "assistant" | null = null;
  const closeMessage = () => {
    if (openRole !== null) {
      out += `    </message>\n`;
      openRole = null;
    }
  };
  const openMessage = (role: "user" | "assistant", attrs = "") => {
    if (openRole === role) return;
    closeMessage();
    out += `    <message role="${role}"${attrs}>\n`;
    openRole = role;
  };
  // If the runner didn't emit any userPrompt events (older runs / replays),
  // fall back to printing the workflow prompt as the user turn so the
  // conversation still reads cleanly.
  if (s.userPrompts.length === 0) {
    openMessage("user");
    out += `      <content>${cdata(s.prompt)}</content>\n`;
  }
  for (const it of items) {
    if (it.kind === "sentPrompt") {
      const p = it.prompt;
      openMessage("user", ` attempt="${p.attempt}"`);
      out += `      <content>${cdata(p.text)}</content>\n`;
    } else if (it.kind === "text") {
      openMessage("assistant");
      out += `      <text ordinal="${it.part.ordinal}" partID="${escAttr(it.part.partID)}">${cdata(it.part.text)}</text>\n`;
    } else if (it.kind === "reasoning") {
      openMessage("assistant");
      out += `      <reasoning ordinal="${it.part.ordinal}" partID="${escAttr(it.part.partID)}">${cdata(it.part.text)}</reasoning>\n`;
    } else if (it.kind === "tool") {
      openMessage("assistant");
      const c = it.call;
      const elapsed = c.elapsedMs !== undefined ? ` elapsedMs="${c.elapsedMs}"` : "";
      out += `      <toolCall ordinal="${c.ordinal}" callID="${escAttr(c.callID)}" tool="${escAttr(c.tool)}" status="${escAttr(c.status)}"${elapsed}>\n`;
      out += `        <input>${cdata(stringifyMaybe(c.input))}</input>\n`;
      if (c.output !== undefined && c.output !== "") {
        out += `        <output>${cdata(c.output)}</output>\n`;
      }
      if (c.error) {
        out += `        <error>${cdata(c.error)}</error>\n`;
      }
      out += `      </toolCall>\n`;
    } else if (it.kind === "retry") {
      // schemaRetry is a runner-side signal, not part of either speaker's
      // message — close the open turn so it renders between them.
      closeMessage();
      const r = it.retry;
      out += `    <schemaRetry attempt="${r.attempt}" maxRetries="${r.maxRetries}">${cdata(r.error)}</schemaRetry>\n`;
    }
  }
  closeMessage();
  out += `  </conversation>\n`;
  if (end) {
    out += `  <result ok="${end.ok}" reason="${escAttr(end.reason)}" elapsedMs="${end.elapsedMs}">\n`;
    if (end.tokens) {
      const tk = end.tokens;
      out += `    <tokens inputChars="${tk.inputChars}" outputChars="${tk.outputChars}" totalChars="${tk.totalChars}" inputTokens="${tk.inputTokens}" outputTokens="${tk.outputTokens}" totalTokens="${tk.totalTokens}" />\n`;
    }
    if (end.output !== undefined) {
      out += `    <output>${cdata(stringifyMaybe(end.output))}</output>\n`;
    }
    if (end.rawText) {
      out += `    <rawText>${cdata(end.rawText)}</rawText>\n`;
    }
    out += `  </result>\n`;
  }
  out += `</agentLog>\n`;
  return out;
}
