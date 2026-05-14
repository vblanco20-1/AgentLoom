import { useRun } from "../store/runStore";
import { AgentCard } from "./AgentCard";

export function AgentGrid({ runId }: { runId: string }) {
  const order = useRun((s) => s.agentOrder);
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
      gap: 14,
    }}>
      {order.map((id) => <AgentCard key={id} agentId={id} runId={runId} />)}
    </div>
  );
}
