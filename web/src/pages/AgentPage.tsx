import { useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useRun } from "../store/runStore";
import { RunWsClient } from "../api/wsClient";
import { TranscriptModal } from "../components/TranscriptModal";

export function AgentPage() {
  const { runId = "", agentId = "" } = useParams<{ runId: string; agentId: string }>();
  const apply = useRun((s) => s.apply);
  const reset = useRun((s) => s.reset);
  const agent = useRun((s) => s.agents[agentId]);

  useEffect(() => {
    reset();
    const client = new RunWsClient(runId, { onEvent: apply });
    client.open();
    return () => client.close();
  }, [runId, apply, reset]);

  if (!agent) {
    return <div style={{ opacity: 0.6 }}>Loading agent {agentId.slice(0, 8)}…</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to={`/run/${runId}`} style={{ color: "#8ad7ff" }}>← back to run</Link>
      </div>
      <h2 style={{ marginTop: 0 }}>{agent.label ?? agentId.slice(0, 8)}</h2>
      <TranscriptModal agent={agent} />
    </div>
  );
}
