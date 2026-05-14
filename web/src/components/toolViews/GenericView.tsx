import { useState } from "react";
import type { ToolCallState } from "../../store/runStore";
import { useStickyScroll } from "../../lib/useStickyScroll";

export function GenericView({ call }: { call: ToolCallState }) {
  const [open, setOpen] = useState(false);
  const borderColor = call.status === "completed" ? "#4ecb71" : call.status === "error" ? "#cb4e4e" : "#666";
  const outRef = useStickyScroll<HTMLPreElement>(call.output?.length ?? 0);
  return (
    <div style={{
      borderLeft: `3px solid ${borderColor}`,
      padding: "4px 8px",
      margin: "4px 0",
      background: "#1a1c26",
      borderRadius: "0 4px 4px 0",
      fontSize: 12,
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ color: "#bbb", cursor: "pointer", display: "flex", justifyContent: "space-between" }}
      >
        <span><strong>{call.tool}</strong> {summarise(call.input)}</span>
        <span>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <>
          <pre style={{ color: "#888", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>{JSON.stringify(call.input, null, 2)}</pre>
          {call.output && (
            <pre ref={outRef} style={{ color: "#9ef0aa", margin: "4px 0", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>{call.output.slice(0, 2000)}</pre>
          )}
          {call.error && <pre style={{ color: "#f09494", margin: "4px 0" }}>{call.error}</pre>}
        </>
      )}
    </div>
  );
}

function summarise(input: unknown): string {
  if (input === null || input === undefined) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return String(input);
  }
}
