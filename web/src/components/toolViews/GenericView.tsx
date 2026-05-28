import { useState } from "react";
import type { ToolCallState } from "../../store/runStore";
import { useStickyScroll } from "../../lib/useStickyScroll";

export function GenericView({ call }: { call: ToolCallState }) {
  const [outOpen, setOutOpen] = useState(false);
  const borderColor = call.status === "completed" ? "#4ecb71" : call.status === "error" ? "#cb4e4e" : "#666";
  const outRef = useStickyScroll<HTMLPreElement>(call.output?.length ?? 0);
  const hasInput = call.input !== null && call.input !== undefined && !(typeof call.input === "object" && Object.keys(call.input as object).length === 0);
  const hasOutput = !!call.output && call.output.length > 0;
  return (
    <div style={{
      borderLeft: `3px solid ${borderColor}`,
      padding: "4px 8px",
      margin: "4px 0",
      background: "#1a1c26",
      borderRadius: "0 4px 4px 0",
      fontSize: 12,
    }}>
      <div style={{ color: "#bbb", fontWeight: 600 }}>{call.tool}</div>
      {hasInput && (
        <pre style={{
          color: "#d4c98a",
          margin: "4px 0 0",
          padding: 6,
          background: "#0c0c10",
          borderRadius: 3,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 160,
          overflowY: "auto",
        }}>{formatInput(call.input)}</pre>
      )}
      {hasOutput && (
        <>
          <div
            onClick={() => setOutOpen((v) => !v)}
            style={{ color: "#888", cursor: "pointer", marginTop: 4, fontSize: 11 }}
          >
            {outOpen ? "▾" : "▸"} output ({call.output!.length.toLocaleString()} chars)
          </div>
          {outOpen && (
            <pre ref={outRef} style={{ color: "#9ef0aa", margin: "4px 0 0", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>{call.output!.slice(0, 4000)}</pre>
          )}
        </>
      )}
      {call.error && <pre style={{ color: "#f09494", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{call.error}</pre>}
    </div>
  );
}

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
