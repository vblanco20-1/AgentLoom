// Spins up an in-process fake opencode server, points a WorktreeServer at it,
// and exercises the SSE -> SessionTracker -> promptRunner flow without any
// real opencode/LLM dependency.

import { describe, it, expect } from "bun:test";
import { SessionTracker } from "../src/driver/SessionTracker.ts";
import type { Event } from "@opencode-ai/sdk";

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
    const partTextA: Event = {
      type: "message.part.updated",
      properties: {
        delta: "Hello",
        part: { id: "p1", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "text", text: "Hello" },
      },
    };
    const partTextB: Event = {
      type: "message.part.updated",
      properties: {
        delta: " world",
        part: { id: "p1", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "text", text: "Hello world" },
      },
    };
    const toolStart: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p2", sessionID: "sess1", messageID: ASSISTANT_MSG, type: "tool",
          callID: "c1", tool: "bash",
          state: { status: "running", input: { cmd: "ls" }, time: { start: 1 } },
        },
      },
    };
    const toolDone: Event = {
      type: "message.part.updated",
      properties: {
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
    };
    const idleEv: Event = {
      type: "session.idle",
      properties: { sessionID: "sess1" },
    };

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
      type: "message.part.updated",
      properties: {
        delta: "what is 2+2",
        part: { id: "p_user", sessionID: "sess", messageID: "msg_user", type: "text", text: "what is 2+2" },
      },
    } as Event);
    expect(textTouched).toBe(false);

    // Assistant reasoning part on a different messageID — must be assembled.
    t.handle({
      type: "message.part.updated",
      properties: {
        delta: "Let me think…",
        part: {
          id: "r1", sessionID: "sess", messageID: "msg_assistant",
          type: "reasoning", text: "Let me think…", time: { start: 1 },
        },
      },
    } as Event);
    t.handle({
      type: "message.part.updated",
      properties: {
        delta: " 4.",
        part: {
          id: "r1", sessionID: "sess", messageID: "msg_assistant",
          type: "reasoning", text: "Let me think… 4.", time: { start: 1 },
        },
      },
    } as Event);
    expect(reasoning.join("")).toBe("Let me think… 4.");
    expect(t.finalReasoning()).toBe("Let me think… 4.");
  });
});
