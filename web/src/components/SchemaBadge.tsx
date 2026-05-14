interface Props {
  hasSchema: boolean;
  status: "running" | "ok" | "fail" | "queued";
  reason?: string;
}

export function SchemaBadge({ hasSchema, status, reason }: Props) {
  if (!hasSchema) {
    return (
      <span title="No schema" style={chip("#444", "#aaa")}>
        no-schema
      </span>
    );
  }
  if (status === "running" || status === "queued") return <span style={chip("#3a3a48", "#bbb")}>schema</span>;
  if (status === "ok") return <span style={chip("#1f4a2a", "#9ef0aa")}>schema ok</span>;
  return <span style={chip("#4a1f1f", "#f09494")} title={reason}>schema {reason ?? "fail"}</span>;
}

function chip(bg: string, fg: string) {
  return {
    background: bg,
    color: fg,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    marginLeft: 8,
  } as const;
}
