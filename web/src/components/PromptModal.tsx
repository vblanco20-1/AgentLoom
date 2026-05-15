import { useEffect } from "react";

// Overlay popup that shows an agent's full prompt text. The caller controls
// visibility via `open`; clicking the backdrop or pressing Escape calls
// `onClose`. Stop-propagation on the dialog box keeps clicks inside from
// closing it. Body scroll is locked while open so the underlying card grid
// doesn't jiggle behind the overlay on wheel events.
export function PromptModal({ open, title, prompt, onClose }: {
  open: boolean;
  title: string;
  prompt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#15161e",
          border: "1px solid #292932",
          borderRadius: 8,
          maxWidth: 900,
          width: "100%",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderBottom: "1px solid #292932",
        }}>
          <strong style={{ fontSize: 14 }}>Prompt — {title}</strong>
          <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
            {prompt.length.toLocaleString()} chars
          </span>
          <button
            onClick={() => { void navigator.clipboard.writeText(prompt); }}
            style={{
              background: "#2a3a4a",
              color: "#8ad7ff",
              border: "1px solid #3a4a5a",
              padding: "3px 10px",
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
            }}
            title="Copy prompt to clipboard"
          >copy</button>
          <button
            onClick={onClose}
            style={{
              background: "#2d2f3b",
              color: "#e9e9ee",
              border: "1px solid #3a3c4a",
              padding: "3px 10px",
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
            }}
          >close</button>
        </div>
        <pre style={{
          margin: 0,
          padding: 16,
          background: "#0c0c10",
          color: "#e9e9ee",
          fontSize: 12,
          fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowY: "auto",
          flex: 1,
        }}>
          {prompt.length > 0 ? prompt : "(empty prompt)"}
        </pre>
      </div>
    </div>
  );
}
