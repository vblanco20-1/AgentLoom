import { useState } from "react";
import type { PendingPermission } from "../store/runStore";
import { useWs } from "../lib/wsContext";

// Rendered inside an AgentCard whenever opencode has emitted permission.asked
// and we haven't seen the matching permission.replied yet. Each pending entry
// gets allow / always / deny buttons; the buttons disable themselves on
// click and stay disabled (the row disappears once the server-side reply
// produces a permission.replied event that the store consumes).
export function PermissionPanel({ pending }: { pending: PendingPermission[] }) {
  if (pending.length === 0) return null;
  return (
    <div style={{
      marginTop: 8,
      border: "1px solid #6e5300",
      background: "#1f1a08",
      borderRadius: 6,
      padding: "8px 10px",
      fontSize: 12,
    }}>
      <div style={{ color: "#ffdf6f", fontWeight: 600, marginBottom: 6 }}>
        permission requested ({pending.length})
      </div>
      {pending.map((p) => <PermissionRow key={p.requestID} p={p} />)}
    </div>
  );
}

function PermissionRow({ p }: { p: PendingPermission }) {
  const ws = useWs();
  const [busy, setBusy] = useState(false);
  // Some opencode permission events carry a `filepath` in metadata (read /
  // external_directory). Others carry a `command` (bash). Pick whichever
  // best identifies the request; fall back to the pattern list.
  const md = p.metadata as { filepath?: string; command?: string; parentDir?: string };
  const detail = md.filepath ?? md.command ?? p.patterns.join(", ");

  const decide = (reply: "once" | "always" | "reject"): void => {
    if (!ws || busy) return;
    setBusy(true);
    ws.replyPermission(p.requestID, reply);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: "1px solid #3a2f08" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#ffdf6f", fontFamily: "ui-monospace, SF Mono, Menlo, monospace" }}>{p.permission}</div>
        <div style={{
          opacity: 0.85,
          fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }} title={detail}>{detail}</div>
      </div>
      <button
        disabled={busy || !ws}
        onClick={() => decide("once")}
        style={btnStyle("#1b3a1f", "#94f094", "#2c5a30")}
      >allow</button>
      <button
        disabled={busy || !ws}
        onClick={() => decide("always")}
        style={btnStyle("#143246", "#8ad7ff", "#1f4a6a")}
        title="Allow this and any future matching request in the session"
      >always</button>
      <button
        disabled={busy || !ws}
        onClick={() => decide("reject")}
        style={btnStyle("#3a1818", "#f09494", "#5a2828")}
      >deny</button>
    </div>
  );
}

function btnStyle(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    padding: "3px 8px",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 11,
  };
}
