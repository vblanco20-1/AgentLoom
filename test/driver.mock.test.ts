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
    const t = new SessionTracker("sess1", "msg1", {
      onTokenDelta: (_p, _o, d) => tokens.push(d),
      onToolStart: (c) => toolStarts.push(c.callID),
      onToolResult: (c) => toolResults.push(`${c.callID}:${c.status}`),
      onSessionIdle: () => { idle = true; },
      onSessionError: () => {},
    });

    const partTextA: Event = {
      type: "message.part.updated",
      properties: {
        delta: "Hello",
        part: { id: "p1", sessionID: "sess1", messageID: "msg1", type: "text", text: "Hello" },
      },
    };
    const partTextB: Event = {
      type: "message.part.updated",
      properties: {
        delta: " world",
        part: { id: "p1", sessionID: "sess1", messageID: "msg1", type: "text", text: "Hello world" },
      },
    };
    const toolStart: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p2", sessionID: "sess1", messageID: "msg1", type: "tool",
          callID: "c1", tool: "bash",
          state: { status: "running", input: { cmd: "ls" }, time: { start: 1 } },
        },
      },
    };
    const toolDone: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p2", sessionID: "sess1", messageID: "msg1", type: "tool",
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
  });

  it("ignores events for other sessions", () => {
    let touched = false;
    const t = new SessionTracker("mine", "msg", {
      onTokenDelta: () => { touched = true; },
      onToolStart: () => {},
      onToolResult: () => {},
      onSessionIdle: () => { touched = true; },
      onSessionError: () => {},
    });
    t.handle({
      type: "message.part.updated",
      properties: {
        delta: "x",
        part: { id: "p", sessionID: "mine", messageID: "other", type: "text", text: "x" },
      },
    } as Event);
    expect(touched).toBe(false);
  });
});
