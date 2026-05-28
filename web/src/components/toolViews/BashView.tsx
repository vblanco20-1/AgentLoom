import type { ToolCallState } from "../../store/runStore";
import { useStickyScroll } from "../../lib/useStickyScroll";

// Bash-specific params the model commonly passes; everything else falls
// through to the catch-all "other args" block so nothing is silently dropped.
const KNOWN_KEYS = new Set(["command", "description", "timeout", "run_in_background"]);

export function BashView({ call }: { call: ToolCallState }) {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const cmd = typeof input.command === "string" ? input.command : JSON.stringify(call.input);
  const description = typeof input.description === "string" ? input.description : undefined;
  const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
  const background = input.run_in_background === true;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v;
  }
  const hasExtras = Object.keys(extras).length > 0;
  const borderColor = call.status === "completed" ? "#4ecb71" : call.status === "error" ? "#cb4e4e" : "#666";
  const outRef = useStickyScroll<HTMLPreElement>(call.output?.length ?? 0);
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
      {description && (
        <div style={{ color: "#888", fontStyle: "italic", marginBottom: 2 }}># {description}</div>
      )}
      <div style={{ color: "#bbb", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>$ {cmd}</div>
      {(timeout !== undefined || background || hasExtras) && (
        <div style={{ color: "#d4c98a", fontSize: 11, marginTop: 2 }}>
          {timeout !== undefined && <span style={{ marginRight: 10 }}>timeout: {timeout}ms</span>}
          {background && <span style={{ marginRight: 10 }}>background: true</span>}
          {hasExtras && (
            <pre style={{ margin: "2px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#d4c98a" }}>{JSON.stringify(extras, null, 2)}</pre>
          )}
        </div>
      )}
      {call.output && (
        <pre ref={outRef} style={{ color: "#9ef0aa", margin: "4px 0 0", whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{call.output.slice(0, 4000)}</pre>
      )}
      {call.error && (
        <pre style={{ color: "#f09494", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{call.error.slice(0, 1000)}</pre>
      )}
    </div>
  );
}
