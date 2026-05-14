export const meta = {
  name: "minimal",
  description: "Sanity check: spawn one sub-agent, no schema, return its JSON.",
  phases: [{ title: "Probe" }],
};

phase("Probe");
log("minimal workflow: starting");
// Every agent() call enforces JSON now — even without an explicit schema
// the runtime binds a permissive { type: "object" } and parses the reply.
const out = await agent('Reply with {"ok": true} and nothing else.', {
  label: "probe",
  phase: "Probe",
});
log(`probe result: ${out === null ? "null" : JSON.stringify(out).slice(0, 80)}`);
return { ok: out !== null, parsed: out };
