import { Routes, Route, Link, Navigate } from "react-router-dom";
import { RunListPage } from "./pages/RunListPage";
import { RunPage } from "./pages/RunPage";
import { AgentPage } from "./pages/AgentPage";
import { TokensPerSecondMeter } from "./components/TokensPerSecondMeter";

export function App() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Keyframes powering the dot in the throughput meter. Inlined here so
          the meter component stays self-contained (no global CSS file). */}
      <style>{`@keyframes agentRunnerPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      <header style={{
        padding: "12px 20px",
        borderBottom: "1px solid #222",
        display: "flex",
        gap: 16,
        alignItems: "center",
      }}>
        <Link to="/runs" style={{ color: "#e9e9ee", fontWeight: 600, textDecoration: "none" }}>
          agent-runner
        </Link>
        <Link to="/runs" style={{ color: "#8ad7ff", fontSize: 13 }}>history</Link>
        <div style={{ marginLeft: "auto" }}>
          <TokensPerSecondMeter />
        </div>
      </header>
      <main style={{ flex: 1, padding: 20 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route path="/runs" element={<RunListPage />} />
          <Route path="/run/:runId" element={<RunPage />} />
          <Route path="/run/:runId/agent/:agentId" element={<AgentPage />} />
        </Routes>
      </main>
    </div>
  );
}
