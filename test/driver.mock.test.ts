// Spins up an in-process fake opencode server, points a WorktreeServer at it,
// and exercises the SSE -> SessionTracker -> promptRunner flow without any
// real opencode/LLM dependency.

import { describe, it, expect } from "bun:test";
import { SessionTracker } from "../src/driver/SessionTracker.ts";
import type { Event } from "@opencode-ai/sdk/v2";

describe("SessionTracker", () => {
  it("assembles tokens and tool calls and resolves on idle", () => {
    const tokens: string[] = [];
    const toolStarts: string[] = [];
    const toolResults: string[] = [];
    let idle = false;
    const reasoning: string[] = [];
    const rawTypes: string[] = [];
    const t = new SessionTracker("sess1", "msg1", {
      onTokenDelta: (_p, _o, d) => tokens.push(d),
      onReasoningDelta: (_p, _o, d) => reasoning.push(d),
      onToolStart: (c) => toolStarts.push(c.callID),
      onToolResult: (c) => toolResults.push(`${c.callID}:${c.status}`),
      onRawEvent: (evType) => rawTypes.push(evType),
      onSessionIdle: () => { idle = true; },
      onSessionError: () => {},
    });

    // Tracker.messageID ("msg1") is the id of OUR user prompt; the assistant
    // reply opencode generates uses a different server-side messageID — anything
    // matching ours is the user-echo and gets dropped.
    const ASSISTANT_MSG = "msg_assistant_xyz";
    // v2 EventMessagePartUpdated shape: top-level id, properties carries
    // { sessionID, part, time }. v2 has no `delta` on .updated (deltas come
    // exclusively through message.part.delta); the tracker derives the
    // streaming tail from text.slice(prev) instead.
    const partTextA = {
      id: "ev1",
      type: "message.part.updated",
      properties: {
        sessionID: "sess1",
        time: 1,
        part: { id: "p1", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "text", text: "Hello" },
      },
    } as unknown as Event;
    const partTextB = {
      id: "ev2",
      type: "message.part.updated",
      properties: {
        sessionID: "sess1",
        time: 2,
        part: { id: "p1", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "text", text: "Hello world" },
      },
    } as unknown as Event;
    const toolStart = {
      id: "ev3",
      type: "message.part.updated",
      properties: {
        sessionID: "sess1",
        time: 3,
        part: {
          id: "p2", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "tool",
          callID: "c1", tool: "bash",
          state: { status: "running", input: { cmd: "ls" }, time: { start: 1 } },
        },
      },
    } as unknown as Event;
    const toolDone = {
      id: "ev4",
      type: "message.part.updated",
      properties: {
        sessionID: "sess1",
        time: 4,
        part: {
          id: "p2", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "tool",
          callID: "c1", tool: "bash",
          state: {
            status: "completed", input: { cmd: "ls" },
            output: "a\nb\n", title: "ls", metadata: {},
            time: { start: 1, end: 5 },
          },
        },
      },
    } as unknown as Event;
    const idleEv = {
      id: "ev5",
      type: "session.idle",
      properties: { sessionID: "sess1" },
    } as unknown as Event;

    t.handle(partTextA);
    t.handle(partTextB);
    t.handle(toolStart);
    t.handle(toolDone);
    t.handle(idleEv);

    expect(tokens.join("")).toBe("Hello world");
    expect(toolStarts).toEqual(["c1"]);
    expect(toolResults).toEqual(["c1:completed"]);
    expect(idle).toBe(true);
    expect(t.finalText()).toBe("Hello world");
    // The raw firehose must see EVERY event regardless of structured handling.
    expect(rawTypes).toEqual([
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "message.part.updated",
      "session.idle",
    ]);
  });

  it("drops the user-prompt echo and assembles reasoning parts", () => {
    let textTouched = false;
    const reasoning: string[] = [];
    const t = new SessionTracker("sess", "msg_user", {
      onTokenDelta: () => { textTouched = true; },
      onReasoningDelta: (_p, _o, d) => reasoning.push(d),
      onToolStart: () => {},
      onToolResult: () => {},
      onRawEvent: () => {},
      onSessionIdle: () => {},
      onSessionError: () => {},
    });
    // User-echo: messageID matches the tracker's own — must be skipped.
    t.handle({
      id: "ev1",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 1,
        part: { id: "p_user", sessionID: "sess", messageID: "msg_user", type: "text", text: "what is 2+2" },
      },
    } as unknown as Event);
    expect(textTouched).toBe(false);

    // Assistant reasoning part on a different messageID — must be assembled.
    t.handle({
      id: "ev2",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 2,
        part: {
          id: "r1", sessionID: "sess", messageID: "msg_assistant",
          type: "reasoning", text: "Let me think…", time: { start: 1 },
        },
      },
    } as unknown as Event);
    t.handle({
      id: "ev3",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 3,
        part: {
          id: "r1", sessionID: "sess", messageID: "msg_assistant",
          type: "reasoning", text: "Let me think… 4.", time: { start: 1 },
        },
      },
    } as unknown as Event);
    expect(reasoning.join("")).toBe("Let me think… 4.");
    expect(t.finalReasoning()).toBe("Let me think… 4.");
  });

  it("buffers message.part.delta tokens that arrive before the first .updated, then flushes without double-emitting once the snapshot tags the part as text", () => {
    const tokens: string[] = [];
    const t = new SessionTracker("sess", "msg_user", {
      onTokenDelta: (_p, _o, d) => tokens.push(d),
      onReasoningDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onRawEvent: () => {},
      onSessionIdle: () => {},
      onSessionError: () => {},
    });
    // Stream three deltas before any .updated arrives. Opencode v2 commonly
    // emits these for the first ~100 tokens before producing a snapshot.
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_assistant", partID: "p1", field: "text", delta: "Hel" },
    } as unknown as Event);
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_assistant", partID: "p1", field: "text", delta: "lo " },
    } as unknown as Event);
    // Before the snapshot, the tracker can't know the kind, so tokens stays empty.
    expect(tokens).toEqual([]);

    // Snapshot arrives — kind becomes "text", buffered deltas flush in order,
    // and the snapshot's tail beyond what we already streamed is appended.
    t.handle({
      id: "ev_snap",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 10,
        part: { id: "p1", sessionID: "sess", messageID: "msg_assistant", type: "text", text: "Hello world" },
      },
    } as unknown as Event);
    expect(tokens.join("")).toBe("Hello world");
    expect(t.finalText()).toBe("Hello world");

    // Subsequent .delta tokens after the snapshot route directly to text.
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_assistant", partID: "p1", field: "text", delta: "!" },
    } as unknown as Event);
    expect(tokens.join("")).toBe("Hello world!");
    expect(t.finalText()).toBe("Hello world!");
  });

  it("flushes leftover pending deltas as text on session.idle so JSON-mode runs don't see an empty finalText", () => {
    const tokens: string[] = [];
    let idle = false;
    const t = new SessionTracker("sess", "msg_user", {
      onTokenDelta: (_p, _o, d) => tokens.push(d),
      onReasoningDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onRawEvent: () => {},
      onSessionIdle: () => { idle = true; },
      onSessionError: () => {},
    });
    // Only message.part.delta events arrive — no .updated snapshot ever
    // confirms the partID's kind. Without the idle-flush these would be lost.
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_assistant", partID: "p1", field: "text", delta: "{\"ok\":" },
    } as unknown as Event);
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_assistant", partID: "p1", field: "text", delta: "true}" },
    } as unknown as Event);
    expect(tokens).toEqual([]);
    expect(t.finalText()).toBe("");

    t.handle({ id: "ev_idle", type: "session.idle", properties: { sessionID: "sess" } } as unknown as Event);
    expect(idle).toBe(true);
    expect(t.finalText()).toBe("{\"ok\":true}");
    expect(tokens.join("")).toBe("{\"ok\":true}");
  });

  it("reports rough token stats covering prompts, assistant text, reasoning, and tool I/O", () => {
    const t = new SessionTracker("sess", "msg_user", {
      onTokenDelta: () => {},
      onReasoningDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onRawEvent: () => {},
      onSessionIdle: () => {},
      onSessionError: () => {},
    });
    // Empty up front — nothing pushed in, nothing observed.
    const empty = t.tokenStats();
    expect(empty.totalChars).toBe(0);
    expect(empty.totalTokens).toBe(0);

    // 12-char user prompt → input bucket.
    t.noteUserPrompt("hello world!");
    // 5-char assistant text part.
    t.handle({
      id: "ev_text",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 1,
        part: { id: "p1", sessionID: "sess", messageID: "msg_assistant", type: "text", text: "READY" },
      },
    } as unknown as Event);
    // 7-char reasoning part.
    t.handle({
      id: "ev_reason",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 2,
        part: { id: "r1", sessionID: "sess", messageID: "msg_assistant", type: "reasoning", text: "ponders", time: { start: 1 } },
      },
    } as unknown as Event);
    // Tool round-trip — input args 13 chars when JSON-stringified ({"cmd":"ls"}=13),
    // output "a\nb\n" = 4 chars.
    t.handle({
      id: "ev_tool",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 3,
        part: {
          id: "p2", sessionID: "sess", messageID: "msg_assistant", type: "tool",
          callID: "c1", tool: "bash",
          state: { status: "completed", input: { cmd: "ls" }, output: "a\nb\n", title: "ls", metadata: {}, time: { start: 1, end: 2 } },
        },
      },
    } as unknown as Event);

    const stats = t.tokenStats();
    // input = user prompt (12) + tool output (4) = 16
    expect(stats.inputChars).toBe(16);
    // output = assistant text (5) + reasoning (7) + tool input JSON ({"cmd":"ls"} = 12) = 24
    expect(stats.outputChars).toBe(24);
    expect(stats.totalChars).toBe(40);
    // Rough = ceil(chars / 4)
    expect(stats.inputTokens).toBe(4);   // ceil(16/4) = 4
    expect(stats.outputTokens).toBe(6);  // ceil(24/4) = 6
    expect(stats.totalTokens).toBe(10);  // ceil(40/4) = 10
  });

  it("drops buffered deltas that turn out to belong to the user-prompt echo", () => {
    const tokens: string[] = [];
    const t = new SessionTracker("sess", "msg_user", {
      onTokenDelta: (_p, _o, d) => tokens.push(d),
      onReasoningDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onRawEvent: () => {},
      onSessionIdle: () => {},
      onSessionError: () => {},
    });
    // A delta on a partID whose messageID matches the tracker's user message
    // must never escape as an assistant token.
    t.handle({
      type: "message.part.delta",
      properties: { sessionID: "sess", messageID: "msg_user", partID: "p_user", field: "text", delta: "what is 2+2" },
    } as unknown as Event);
    t.handle({
      id: "ev_user",
      type: "message.part.updated",
      properties: {
        sessionID: "sess",
        time: 1,
        part: { id: "p_user", sessionID: "sess", messageID: "msg_user", type: "text", text: "what is 2+2" },
      },
    } as unknown as Event);
    expect(tokens).toEqual([]);
    expect(t.finalText()).toBe("");
  });
});
