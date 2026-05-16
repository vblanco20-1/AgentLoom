export const meta = {
  name: "memory-demo",
  description:
    "Three sequential agents share a notes.md scratchpad. Each one is told to read what the previous agent wrote and append its own.",
  phases: [
    { title: "Plan" },
    { title: "Execute" },
    { title: "Review" },
  ],
};

memory("notes.md");

phase("Plan");
const plan = await agent(
  "Outline a 2-step plan for a trivial task: writing a short poem about a cat. Append your plan to the notes file.",
  { label: "plan", phase: "Plan" },
);

phase("Execute");
const draft = await agent(
  "Read the prior plan from the notes file, then write the poem and append it. Reply with the poem text in JSON {\"poem\": \"...\"}.",
  {
    label: "execute",
    phase: "Execute",
    schema: {
      type: "object",
      required: ["poem"],
      properties: { poem: { type: "string" } },
    },
  },
);

phase("Review");
const review = await agent(
  "Read the notes file to see the plan and the poem, then append a 1-sentence critique. Reply with {\"verdict\": \"good\"|\"bad\"}.",
  {
    label: "review",
    phase: "Review",
    schema: {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { enum: ["good", "bad"] } },
    },
  },
);

memory(null);

return { plan, draft, review };
