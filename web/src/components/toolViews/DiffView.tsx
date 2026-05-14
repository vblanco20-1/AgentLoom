import type { ToolCallState } from "../../store/runStore";
import { useStickyScroll } from "../../lib/useStickyScroll";

export function DiffView({ call }: { call: ToolCallState }) {
  const input = call.input as
    | { file_path?: string; old_string?: string; new_string?: string; content?: string }
    | undefined;
  const borderColor = call.status === "completed" ? "#4ecb71" : call.status === "error" ? "#cb4e4e" : "#666";
  const oldRef = useStickyScroll<HTMLPreElement>(input?.old_string?.length ?? 0);
  const newRef = useStickyScroll<HTMLPreElement>(input?.new_string?.length ?? 0);
  const contentRef = useStickyScroll<HTMLPreElement>(input?.content?.length ?? 0);
  return (
    <div style={{
      borderLeft: `3px solid ${borderColor}`,
      padding: "4px 8px",
      margin: "4px 0",
      background: "#1a1c26",
      borderRadius: "0 4px 4px 0",
      fontSize: 12,
    }}>
      <div style={{ color: "#bbb" }}>{call.tool}: <code>{input?.file_path ?? "?"}</code></div>
      {input?.old_string !== undefined && (
        <pre ref={oldRef} style={{ color: "#f09494", margin: "4px 0", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>{`- ${input.old_string.slice(0, 1000)}`}</pre>
      )}
      {input?.new_string !== undefined && (
        <pre ref={newRef} style={{ color: "#9ef0aa", margin: "4px 0", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>{`+ ${input.new_string.slice(0, 1000)}`}</pre>
      )}
      {input?.content !== undefined && (
        <pre ref={contentRef} style={{ color: "#9ef0aa", margin: "4px 0", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto" }}>{input.content.slice(0, 1000)}</pre>
      )}
      {call.error && <pre style={{ color: "#f09494", margin: "4px 0" }}>{call.error}</pre>}
    </div>
  );
}
