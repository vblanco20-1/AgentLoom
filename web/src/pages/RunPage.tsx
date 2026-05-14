import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useRun } from "../store/runStore";
import { RunWsClient } from "../api/wsClient";
import { PhaseTimeline } from "../components/PhaseTimeline";
import { AgentGrid } from "../components/AgentGrid";

export function RunPage() {
  const { runId = "" } = useParams<{ runId: string }>();
  const apply = useRun((s) => s.apply);
  const reset = useRun((s) => s.reset);
  const meta = useRun((s) => s.meta);
  const startedAt = useRun((s) => s.startedAt);
  const ok = useRun((s) => s.ok);
  const wsRef = useRef<RunWsClient | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    reset();
    const client = new RunWsClient(runId, { onEvent: apply });
    client.open();
    wsRef.current = client;
    const tick = setInterval(() => force((x) => x + 1), 250);
    return () => {
      clearInterval(tick);
      client.close();
    };
  }, [runId, apply, reset]);

  const elapsedMs = startedAt ? Date.now() - startedAt : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{meta?.name ?? runId.slice(0, 8)}</h2>
        <div style={{ opacity: 0.6, fontSize: 13 }}>{meta?.description}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ opacity: 0.6 }}>{(elapsedMs / 1000).toFixed(1)}s</span>
          {ok === true && <span style={{ color: "#94f094" }}>ok</span>}
          {ok === false && <span style={{ color: "#f09494" }}>fail</span>}
          <button
            onClick={() => wsRef.current?.abortAll()}
            style={{ background: "#4a2222", color: "#f09494", border: "1px solid #5a3232", padding: "6px 12px", borderRadius: 4, cursor: "pointer" }}
          >
            abort
          </button>
        </div>
      </div>
      <PhaseTimeline />
      <AgentGrid runId={runId} />
    </div>
  );
}
