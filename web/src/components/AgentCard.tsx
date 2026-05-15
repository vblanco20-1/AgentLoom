import { useState } from "react";
import { Link } from "react-router-dom";
import { useRun, timelineFor } from "../store/runStore";
import { SchemaBadge } from "./SchemaBadge";
import { RawEventLog } from "./RawEventLog";
import { Timeline } from "./Timeline";
import { PermissionPanel } from "./PermissionPanel";
import { PromptModal } from "./PromptModal";
import { useWs } from "../lib/wsContext";

export function AgentCard({ agentId, runId }: { agentId: string; runId: string }) {
  const a = useRun((s) => s.agents[agentId]);
  const ws = useWs();
  const [promptOpen, setPromptOpen] = useState(false);
  if (!a) return null;
  const elapsed = (a.endedAt ?? Date.now()) - a.startedAt;
  const items = timelineFor(a);
  const isRunning = a.status === "running";
  const pending = Object.values(a.pendingPermissions);
  const labelText = a.label ?? agentId.slice(0, 8);
  return (
    <div style={{
      background: "#15161e",
      border: "1px solid #292932",
      borderRadius: 8,
      padding: 14,
    }}>
      <h3 style={{ margin: 0, fontSize: 14, display: "flex", alignItems: "center" }}>
        <Link to={`/run/${runId}/agent/${agentId}`} style={{ color: "#e9e9ee", textDecoration: "none" }}>
          {labelText}
        </Link>
        <button
          onClick={() => setPromptOpen(true)}
          style={{
            marginLeft: 6,
            background: "transparent",
            color: "#9ec5ff",
            border: "1px solid #2d3a52",
            padding: "1px 7px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            lineHeight: "16px",
          }}
          title="Show the full prompt sent to this agent"
        >prompt</button>
        <span style={{
          display: "inline-block",
          padding: "2px 8px",
          marginLeft: 8,
          borderRadius: 999,
          fontSize: 11,
          background: a.status === "running" ? "#5a4400" : a.status === "ok" ? "#224d22" : "#4d2222",
          color: a.status === "running" ? "#ffdf6f" : a.status === "ok" ? "#94f094" : "#f09494",
        }}>
          {a.status === "running" ? "running" : a.status === "ok" ? "ok" : (a.reason ?? "fail")}
        </span>
        <SchemaBadge hasSchema={!!a.schemaHash} status={a.status} reason={a.reason} />
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>{(elapsed / 1000).toFixed(1)}s</span>
      </h3>
      <div style={{ color: "#888", fontSize: 12, margin: "6px 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
        {a.phase && <span>[{a.phase}]</span>}
        <span title={a.cwd} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shorten(a.cwd, 50)}</span>
        <button
          disabled={!ws || !isRunning}
          onClick={() => ws?.abortAgent(agentId)}
          style={actionBtnStyle(isRunning ? "#4a2222" : "#2a2a30", isRunning ? "#f09494" : "#666", isRunning ? "#5a3232" : "#3a3a40", !isRunning)}
          title={isRunning ? "Abort this agent" : "Agent already ended"}
        >abort</button>
        <button
          disabled={!ws}
          onClick={() => ws?.retryAgent(agentId)}
          style={actionBtnStyle("#2a3a4a", "#8ad7ff", "#3a4a5a", !ws)}
          title="Re-run this prompt as a fresh agent"
        >retry</button>
      </div>
      <PermissionPanel pending={pending} />
      <Timeline items={items} dense />
      <div style={{ marginTop: 8 }}>
        <RawEventLog events={a.rawEvents} maxHeight={220} />
      </div>
      <PromptModal
        open={promptOpen}
        title={labelText}
        prompt={a.prompt}
        onClose={() => setPromptOpen(false)}
      />
    </div>
  );
}

function actionBtnStyle(bg: string, fg: string, border: string, disabled: boolean): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    padding: "3px 10px",
    borderRadius: 4,
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

function shorten(p: string, n: number): string {
  if (p.length <= n) return p;
  return "…" + p.slice(-n + 1);
}
