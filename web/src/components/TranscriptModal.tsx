import type { AgentState } from "../store/runStore";

export function TranscriptModal({ agent }: { agent: AgentState }) {
  return (
    <div style={{ background: "#15161e", border: "1px solid #292932", borderRadius: 8, padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>Transcript</h3>
      <div style={{ marginBottom: 12 }}><strong>Prompt</strong></div>
      <pre style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", fontSize: 12 }}>
        {agent.prompt}
      </pre>
      <div style={{ margin: "16px 0 8px" }}><strong>Assistant text</strong></div>
      <pre style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", fontSize: 12 }}>
        {agent.text || "(none)"}
      </pre>
      <div style={{ margin: "16px 0 8px" }}><strong>Final parsed output</strong></div>
      <pre style={{ background: "#0c0c10", padding: 8, borderRadius: 4, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", fontSize: 12 }}>
        {agent.output === null ? "null"
          : agent.output === undefined ? "(no output)"
          : typeof agent.output === "string" ? agent.output
          : JSON.stringify(agent.output, null, 2)}
      </pre>
      <div style={{ margin: "16px 0 8px" }}><strong>Tool calls ({agent.toolCalls.length})</strong></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {agent.toolCalls.map((c) => (
          <div key={c.callID} style={{ background: "#0c0c10", padding: 8, borderRadius: 4, fontSize: 12 }}>
            <div style={{ color: "#bbb", marginBottom: 4 }}>
              <strong>{c.tool}</strong> — {c.status}{c.elapsedMs != null ? `  ${c.elapsedMs}ms` : ""}
            </div>
            <pre style={{ margin: 0, color: "#888", whiteSpace: "pre-wrap" }}>{JSON.stringify(c.input, null, 2)}</pre>
            {c.output && <pre style={{ margin: "6px 0 0", color: "#9ef0aa", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>{c.output}</pre>}
            {c.error && <pre style={{ margin: "6px 0 0", color: "#f09494", whiteSpace: "pre-wrap" }}>{c.error}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
