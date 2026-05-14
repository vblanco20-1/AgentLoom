import { Link } from "react-router-dom";
import { useRun } from "../store/runStore";
import { TokenStream } from "./TokenStream";
import { ToolCallList } from "./ToolCallList";
import { SchemaBadge } from "./SchemaBadge";

export function AgentCard({ agentId, runId }: { agentId: string; runId: string }) {
  const a = useRun((s) => s.agents[agentId]);
  if (!a) return null;
  const elapsed = (a.endedAt ?? Date.now()) - a.startedAt;
  return (
    <div style={{
      background: "#15161e",
      border: "1px solid #292932",
      borderRadius: 8,
      padding: 14,
    }}>
      <h3 style={{ margin: 0, fontSize: 14, display: "flex", alignItems: "center" }}>
        <Link to={`/run/${runId}/agent/${agentId}`} style={{ color: "#e9e9ee", textDecoration: "none" }}>
          {a.label ?? agentId.slice(0, 8)}
        </Link>
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
      <div style={{ color: "#888", fontSize: 12, margin: "6px 0 8px" }}>
        {a.phase && <span style={{ marginRight: 8 }}>[{a.phase}]</span>}
        <span title={a.cwd}>{shorten(a.cwd, 50)}</span>
      </div>
      <TokenStream text={a.text} />
      <ToolCallList calls={a.toolCalls} />
    </div>
  );
}

function shorten(p: string, n: number): string {
  if (p.length <= n) return p;
  return "…" + p.slice(-n + 1);
}
