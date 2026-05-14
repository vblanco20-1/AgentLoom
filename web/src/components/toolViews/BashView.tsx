import type { ToolCallState } from "../../store/runStore";

export function BashView({ call }: { call: ToolCallState }) {
  const cmd = (call.input as { command?: string } | undefined)?.command ?? JSON.stringify(call.input);
  const borderColor = call.status === "completed" ? "#4ecb71" : call.status === "error" ? "#cb4e4e" : "#666";
  return (
    <div style={{
      borderLeft: `3px solid ${borderColor}`,
      padding: "4px 8px",
      margin: "4px 0",
      background: "#1a1c26",
      borderRadius: "0 4px 4px 0",
      fontFamily: "ui-monospace, monospace",
      fontSize: 12,
    }}>
      <div style={{ color: "#bbb" }}>$ {cmd}</div>
      {call.output && (
        <pre style={{ color: "#9ef0aa", margin: "4px 0 0", whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{call.output.slice(0, 4000)}</pre>
      )}
      {call.error && (
        <pre style={{ color: "#f09494", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{call.error.slice(0, 1000)}</pre>
      )}
    </div>
  );
}
