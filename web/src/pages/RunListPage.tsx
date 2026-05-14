import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRuns } from "../api/runApi";
import type { RunIndexEntry } from "../api/types";

export function RunListPage() {
  const [runs, setRuns] = useState<RunIndexEntry[]>([]);
  useEffect(() => {
    void fetchRuns().then(setRuns);
  }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Run history ({runs.length})</h2>
      {runs.length === 0 && <p style={{ opacity: 0.6 }}>No runs yet. Run a workflow with <code>bin/agent-runner run &lt;path&gt;</code>.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {runs.map((r) => (
          <li key={r.runId} style={{ padding: 10, borderBottom: "1px solid #222", display: "flex", justifyContent: "space-between" }}>
            <div>
              <Link to={`/run/${r.runId}`} style={{ color: "#8ad7ff" }}>
                {r.meta?.workflowName ?? r.runId}
              </Link>
              <div style={{ opacity: 0.6, fontSize: 12 }}>{r.meta?.workflowDescription ?? r.meta?.workflowPath ?? ""}</div>
              <div style={{ opacity: 0.4, fontSize: 11 }}>{new Date(r.mtimeMs).toLocaleString()}</div>
            </div>
            <div style={{ alignSelf: "center", color: r.result?.ok === true ? "#94f094" : r.result?.ok === false ? "#f09494" : "#aaa" }}>
              {r.result?.ok === true ? "ok" : r.result?.ok === false ? "fail" : "—"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
