import { useEffect, useRef, useState } from "react";

export function TokenStream({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!ref.current) return;
    if (!autoScroll) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, autoScroll]);

  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        setAutoScroll(atBottom);
      }}
      style={{
        background: "#0c0c10",
        padding: 8,
        borderRadius: 4,
        maxHeight: 260,
        overflowY: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 12,
        margin: 0,
      }}
    >
      {text || <span style={{ opacity: 0.4 }}>(streaming…)</span>}
    </pre>
  );
}
