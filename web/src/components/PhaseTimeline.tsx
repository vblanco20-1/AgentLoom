import { useRun } from "../store/runStore";

export function PhaseTimeline() {
  const phases = useRun((s) => s.phases);
  const active = useRun((s) => s.activePhase);
  const agents = useRun((s) => s.agents);

  if (phases.length === 0) return null;

  const countsByPhase = new Map<string, number>();
  for (const a of Object.values(agents)) {
    if (!a.phase) continue;
    countsByPhase.set(a.phase, (countsByPhase.get(a.phase) ?? 0) + 1);
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
      {phases.map((p) => (
        <div
          key={p}
          style={{
            background: active === p ? "#3d4e6b" : "#1f2030",
            padding: "4px 12px",
            borderRadius: 999,
            fontSize: 12,
            color: active === p ? "#fff" : "#aaa",
          }}
        >
          {p} {countsByPhase.has(p) ? `(${countsByPhase.get(p)})` : ""}
        </div>
      ))}
    </div>
  );
}
