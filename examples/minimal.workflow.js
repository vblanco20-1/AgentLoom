export const meta = {
  name: "minimal",
  description: "Sanity check: spawn one sub-agent, no schema, return its text.",
  phases: [{ title: "Probe" }],
};

phase("Probe");
log("minimal workflow: starting");
const out = await agent('Reply with the exact string "OK" and nothing else.', {
  label: "probe",
  phase: "Probe",
});
log(`probe result: ${typeof out === "string" ? out.slice(0, 80) : JSON.stringify(out)}`);
return { ok: out !== null, text: out };
