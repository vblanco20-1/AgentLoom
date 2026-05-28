import { useEffect, useState } from "react";
import { useRun, tokensPerSecond } from "../store/runStore";

// Global throughput meter shown in the header. Reads the run-store's rolling
// rate buffer at a fixed cadence so the displayed rate keeps decaying when the
// run quiesces — without a tick, a stale 5s window from the last burst would
// stick around until the next event nudges Zustand.
//
// Hidden entirely when nothing has streamed yet (e.g. on the runs-list page,
// or right after a reset), so it doesn't clutter the header.
const TICK_MS = 250;
const WINDOW_MS = 5000;

export function TokensPerSecondMeter() {
  const samples = useRun((s) => s.rateSamples);
  const totalChars = useRun((s) => s.totalChars);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Nothing to show until at least one delta has been observed for this run.
  if (totalChars === 0) return null;

  const tps = tokensPerSecond(samples, now, WINDOW_MS);
  const totalTokens = Math.ceil(totalChars / 4);
  // Three-band colouring so quiet/normal/hot regimes pop visually.
  const color = tps === 0 ? "#666" : tps < 50 ? "#9ec5ff" : tps < 500 ? "#94f094" : "#ffdf6f";

  return (
    <div
      title={tooltip(tps, totalTokens, totalChars, samples.length)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        background: "#0c0c10",
        border: "1px solid #292932",
        borderRadius: 999,
        fontSize: 12,
        lineHeight: "16px",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8, height: 8, borderRadius: "50%",
          background: color,
          // Pulse only while we're actively seeing traffic — calm when idle.
          animation: tps > 0 ? "agentRunnerPulse 1.2s ease-in-out infinite" : "none",
          boxShadow: tps > 0 ? `0 0 6px ${color}` : "none",
        }}
      />
      <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
        {tps.toLocaleString()}
      </span>
      <span style={{ opacity: 0.55 }}>tok/s</span>
      <span style={{ opacity: 0.35, marginLeft: 4, fontSize: 11 }}>
        Σ {fmt(totalTokens)} tok
      </span>
    </div>
  );
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function tooltip(tps: number, totalTokens: number, totalChars: number, n: number): string {
  return (
    `Rough throughput over the last ${WINDOW_MS / 1000}s\n` +
    `  ${tps.toLocaleString()} tokens/s  (chars ÷ 4 ÷ window)\n` +
    `  ${totalChars.toLocaleString()} chars / ~${totalTokens.toLocaleString()} tokens this run\n` +
    `  ${n} sample(s) in the rolling buffer\n` +
    `Counts every byte the runner pushed or pulled: user prompts, assistant\n` +
    `text + reasoning deltas, tool call args, and tool outputs.`
  );
}
