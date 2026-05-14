import { fullText, timelineFor, type AgentState } from "../store/runStore";
import { RawEventLog } from "./RawEventLog";
import { Timeline } from "./Timeline";
import { useStickyScroll } from "../lib/useStickyScroll";

export function TranscriptModal({ agent }: { agent: AgentState }) {
  const items = timelineFor(agent);
  const finalText = fullText(agent);
  const promptRef = useStickyScroll<HTMLPreElement>(agent.prompt.length);
  const finalRef = useStickyScroll<HTMLPreElement>(finalText.length);
  const outputStr =
    agent.output === null ? "null"
      : agent.output === undefined ? "(no output)"
      : typeof agent.output === "string" ? agent.output
      : JSON.stringify(agent.output, null, 2);
  const outputRef = useStickyScroll<HTMLPreElement>(outputStr.length);
  return (
    <div style={{ background: "#15161e", border: "1px solid #292932", borderRadius: 8, padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>Transcript</h3>
      <div style={{ marginBottom: 12 }}><strong>Prompt</strong></div>
      <pre ref={promptRef} style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", fontSize: 12 }}>
        {agent.prompt}
      </pre>

      <div style={{ margin: "16px 0 8px" }}>
        <strong>Timeline</strong>
        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
          (every text / reasoning / tool part in opencode arrival order — tool input + output inline)
        </span>
      </div>
      <Timeline items={items} />

      <div style={{ margin: "16px 0 8px" }}>
        <strong>Final assistant text</strong>
        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
          (canonical full output from agent.end, used for schema validation)
        </span>
      </div>
      <pre ref={finalRef} style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", fontSize: 12 }}>
        {finalText || "(none)"}
      </pre>

      <div style={{ margin: "16px 0 8px" }}><strong>Final parsed output</strong></div>
      <pre ref={outputRef} style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", fontSize: 12 }}>
        {outputStr}
      </pre>

      <div style={{ margin: "16px 0 8px" }}>
        <strong>All raw events</strong>
        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
          (every SSE event opencode emitted for this session — including types
          the timeline does not model: subtask, file, step-start/finish,
          snapshot, patch, retry, compaction, todo.updated, file.edited,
          message.updated finish reason / token usage, etc.)
        </span>
      </div>
      <RawEventLog events={agent.rawEvents} maxHeight={520} defaultOpen />
    </div>
  );
}
