import { useState } from "react";
import type { RawEventEntry } from "../store/runStore";
import { useStickyScroll } from "../lib/useStickyScroll";

export function RawEventLog({ events, maxHeight = 320, defaultOpen = false }: {
  events: RawEventEntry[];
  maxHeight?: number;
  defaultOpen?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const norm = filter.trim().toLowerCase();
  const filtered = norm.length === 0
    ? events
    : events.filter((e) => e.evType.toLowerCase().includes(norm));
  const listRef = useStickyScroll<HTMLDivElement>(filtered.length);
  if (events.length === 0) return null;
  return (
    <details open={defaultOpen} style={{ margin: "0 0 8px", fontSize: 12 }}>
      <summary style={{ cursor: "pointer", color: "#9ec5ff", padding: "4px 0" }}>
        raw events ({events.length.toLocaleString()})
      </summary>
      <div style={{ marginTop: 6 }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by type (e.g. todo, file, session)"
          style={{
            width: "100%",
            background: "#0c0c10",
            color: "#e9e9ee",
            border: "1px solid #292932",
            borderRadius: 4,
            padding: "4px 6px",
            fontSize: 12,
            marginBottom: 6,
          }}
        />
        <div ref={listRef} style={{
          background: "#0c0c10",
          border: "1px solid #292932",
          borderRadius: 4,
          maxHeight,
          overflowY: "auto",
        }}>
          {filtered.map((e, i) => (
            <RawEventRow key={i} entry={e} />
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 8, opacity: 0.5 }}>(no matches)</div>
          )}
        </div>
      </div>
    </details>
  );
}

function RawEventRow({ entry }: { entry: RawEventEntry }) {
  const [open, setOpen] = useState(false);
  const time = new Date(entry.t).toISOString().slice(11, 23);
  return (
    <div style={{ borderBottom: "1px solid #1a1c26", padding: "4px 8px" }}>
      <div
        style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ opacity: 0.5, fontFamily: "ui-monospace, SF Mono, Menlo, monospace" }}>{time}</span>
        <span style={{ color: "#9ec5ff", fontFamily: "ui-monospace, SF Mono, Menlo, monospace" }}>{entry.evType}</span>
        <span style={{ marginLeft: "auto", opacity: 0.4 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <pre style={{
          margin: "4px 0 0",
          padding: 6,
          background: "#000",
          borderRadius: 3,
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 240,
          overflowY: "auto",
        }}>{safeStringify(entry.payload)}</pre>
      )}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
