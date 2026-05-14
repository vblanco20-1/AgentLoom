import { useState } from "react";
import type { TimelineItem } from "../store/runStore";
import { BashView } from "./toolViews/BashView";
import { DiffView } from "./toolViews/DiffView";
import { GenericView } from "./toolViews/GenericView";
import { useStickyScroll } from "../lib/useStickyScroll";

// Renders an agent's parts in ordinal (arrival) order:
// thinking → tool use → thinking → output message → tool use → …
// Tool inputs and outputs are inline within their slot (no separate list).
export function Timeline({ items, dense = false }: { items: TimelineItem[]; dense?: boolean }) {
  if (items.length === 0) {
    return (
      <div style={{ padding: 10, background: "#0c0c10", borderRadius: 4, color: "#666", fontSize: 12 }}>
        (waiting for first part…)
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((it) => {
        if (it.kind === "reasoning") return <ReasoningBlock key={`r-${it.partID}`} part={it} dense={dense} />;
        if (it.kind === "text") return <TextBlock key={`t-${it.partID}`} part={it} dense={dense} />;
        return <ToolBlock key={`c-${it.callID}`} call={it} dense={dense} />;
      })}
    </div>
  );
}

function ReasoningBlock({ part, dense }: { part: { ordinal: number; text: string }; dense: boolean }) {
  const [open, setOpen] = useState(!dense);
  const summary = part.text.slice(0, 80).replace(/\s+/g, " ");
  const scrollRef = useStickyScroll<HTMLPreElement>(part.text.length);
  return (
    <div style={{
      borderLeft: "3px solid #6a5cff",
      padding: "4px 8px",
      background: "#16131f",
      borderRadius: "0 4px 4px 0",
      fontSize: 12,
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer", color: "#b6a4ff", display: "flex", gap: 6, alignItems: "baseline" }}
      >
        <span style={{ fontWeight: 600 }}>thinking</span>
        <span style={{ opacity: 0.55 }}>#{part.ordinal} · {part.text.length.toLocaleString()} chars</span>
        {!open && <span style={{ opacity: 0.45, marginLeft: 6 }}>{summary}{part.text.length > 80 ? "…" : ""}</span>}
        <span style={{ marginLeft: "auto", opacity: 0.4 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <pre ref={scrollRef} style={{
          margin: "4px 0 0",
          padding: 6,
          background: "#0c0c10",
          borderRadius: 4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#b6a4ff",
          opacity: 0.9,
          maxHeight: 240,
          overflowY: "auto",
        }}>
          {part.text}
        </pre>
      )}
    </div>
  );
}

function TextBlock({ part, dense }: { part: { ordinal: number; text: string }; dense: boolean }) {
  const scrollRef = useStickyScroll<HTMLPreElement>(part.text.length);
  return (
    <div style={{
      borderLeft: "3px solid #4ea0ff",
      padding: "6px 8px",
      background: "#11141c",
      borderRadius: "0 4px 4px 0",
      fontSize: 12,
    }}>
      <div style={{ color: "#8ad7ff", fontWeight: 600, fontSize: 11, marginBottom: 4, display: "flex", gap: 6 }}>
        <span>message</span>
        <span style={{ opacity: 0.55 }}>#{part.ordinal}</span>
      </div>
      <pre ref={scrollRef} style={{
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "#e9e9ee",
        maxHeight: dense ? 200 : 360,
        overflowY: "auto",
      }}>
        {part.text || <span style={{ opacity: 0.4 }}>(streaming…)</span>}
      </pre>
    </div>
  );
}

function ToolBlock({ call, dense }: {
  call: {
    callID: string;
    ordinal: number;
    tool: string;
    input: unknown;
    status: "running" | "completed" | "error";
    output?: string;
    error?: string;
    elapsedMs?: number;
  };
  dense: boolean;
}) {
  const t = call.tool.toLowerCase();
  const inner = t === "bash"
    ? <BashView call={call} />
    : (t === "edit" || t === "write")
    ? <DiffView call={call} />
    : <GenericView call={call} />;
  return (
    <div>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>
        tool · #{call.ordinal}{call.elapsedMs != null ? ` · ${call.elapsedMs}ms` : ""}{call.status === "running" ? " · running…" : ""}
      </div>
      {/* The existing tool views already render input + output/error inline,
          so we delegate rather than duplicating the per-tool layout. */}
      <div style={{ marginTop: 0, opacity: dense && call.status === "completed" ? 0.95 : 1 }}>
        {inner}
      </div>
    </div>
  );
}
