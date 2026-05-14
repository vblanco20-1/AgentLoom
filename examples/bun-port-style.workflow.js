export const meta = {
  name: "bun-port-style",
  description: "Implement -> Verify -> Fix pipeline across N items. Demonstrates pipeline+parallel+phase.",
  phases: [
    { title: "Implement", detail: "one agent per file" },
    { title: "Verify", detail: "adversarial 2-vote" },
    { title: "Fix", detail: "merge verifier findings" },
  ],
};

const FILES = (args && args.files) || [
  { name: "alpha.zig" },
  { name: "beta.zig" },
  { name: "gamma.zig" },
];

const IMPL_SCHEMA = {
  type: "object",
  required: ["path", "confidence"],
  properties: {
    path: { type: "string", description: "absolute path written" },
    confidence: { enum: ["high", "medium", "low"] },
    todos: { type: "integer" },
  },
};

const VERIFY_SCHEMA = {
  type: "object",
  required: ["issues"],
  properties: {
    issues: { type: "array", items: { type: "object", required: ["severity", "what"], properties: { severity: { enum: ["info", "warn", "block"] }, what: { type: "string" } } } },
  },
};

log(`bun-port-style: ${FILES.length} files`);
phase("Implement");

const results = await pipeline(
  FILES,
  (f) =>
    agent(`Pretend to port ${f.name} from Zig to Rust. Respond with the schema.`, {
      label: `impl:${f.name}`,
      phase: "Implement",
      schema: IMPL_SCHEMA,
    }),
  (impl, f) => {
    if (!impl) return { ok: false, name: f.name, _skip: true };
    return parallel(
      [0, 1].map((i) => () =>
        agent(`Adversarially verify the port of ${f.name}. Respond with the schema.`, {
          label: `verify[${i}]:${f.name}`,
          phase: "Verify",
          schema: VERIFY_SCHEMA,
        }),
      ),
    ).then((votes) => ({ ok: true, name: f.name, impl, votes }));
  },
  (ver, f) => {
    if (!ver || ver._skip || !ver.ok) return { name: f.name, status: "skipped" };
    return agent(`Apply verifier findings to ${f.name}. Respond with the schema.`, {
      label: `fix:${f.name}`,
      phase: "Fix",
      schema: IMPL_SCHEMA,
    }).then((fix) => ({ name: f.name, status: fix ? "fixed" : "fix-null", impl: ver.impl, fix }));
  },
);

return {
  total: FILES.length,
  fixed: results.filter((r) => r && r.status === "fixed").length,
  results,
};
