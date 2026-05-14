import type { ToolCallState } from "../store/runStore";
import { BashView } from "./toolViews/BashView";
import { DiffView } from "./toolViews/DiffView";
import { GenericView } from "./toolViews/GenericView";

export function ToolCallList({ calls }: { calls: ToolCallState[] }) {
  if (calls.length === 0) return null;
  const sorted = [...calls].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <div style={{ marginTop: 8 }}>
      {sorted.map((c) => {
        const t = c.tool.toLowerCase();
        if (t === "bash") return <BashView key={c.callID} call={c} />;
        if (t === "edit" || t === "write") return <DiffView key={c.callID} call={c} />;
        return <GenericView key={c.callID} call={c} />;
      })}
    </div>
  );
}
