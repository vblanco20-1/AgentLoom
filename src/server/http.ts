import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import type { EventBus } from "../bus/EventBus.ts";
import { WsHub } from "./ws.ts";
import { RunIndex } from "../runs/RunIndex.ts";
import { readEventsFile } from "./replay.ts";

const STATIC_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent-runner</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0c0c10; color: #e9e9ee; }
    header { padding: 14px 20px; border-bottom: 1px solid #222; display: flex; gap: 16px; align-items: center; }
    main { padding: 16px 20px; }
    h1, h2, h3 { font-weight: 600; }
    a { color: #8ad7ff; text-decoration: none; }
    code, pre { font-family: ui-monospace, SF Mono, Menlo, monospace; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }
    .card { background: #15161e; border: 1px solid #292932; border-radius: 8px; padding: 14px; }
    .card h3 { margin: 0 0 8px 0; font-size: 14px; }
    .card .meta { color: #888; font-size: 12px; margin-bottom: 8px; }
    .card pre { max-height: 260px; overflow-y: auto; background: #0c0c10; padding: 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-left: 8px; }
    .status.running { background: #5a4400; color: #ffdf6f; }
    .status.ok { background: #224d22; color: #94f094; }
    .status.fail { background: #4d2222; color: #f09494; }
    /* Per-agent timeline: text / reasoning / tool blocks rendered in
       opencode part-ordinal order. Each block uses a coloured left border
       to make the type readable at a glance. */
    .timeline { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .tl-block { font-size: 12px; padding: 6px 8px; border-radius: 0 4px 4px 0; background: #11141c; border-left: 3px solid #555; }
    .tl-block .tl-head { display: flex; align-items: baseline; gap: 6px; font-weight: 600; font-size: 11px; }
    .tl-block .tl-ord { opacity: 0.55; font-weight: 400; }
    .tl-block .tl-body { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; background: #0c0c10; border-radius: 4px; padding: 6px; }
    .tl-block.text { border-left-color: #4ea0ff; }
    .tl-block.text .tl-head { color: #8ad7ff; }
    .tl-block.text .tl-body { color: #e9e9ee; }
    .tl-block.reasoning { border-left-color: #6a5cff; background: #16131f; }
    .tl-block.reasoning .tl-head { color: #b6a4ff; cursor: pointer; }
    .tl-block.reasoning .tl-body { color: #b6a4ff; opacity: 0.9; display: none; }
    .tl-block.reasoning.open .tl-body { display: block; }
    .tl-block.tool { background: #1a1c26; }
    .tl-block.tool.completed { border-left-color: #4ecb71; }
    .tl-block.tool.error { border-left-color: #cb4e4e; }
    .tl-block.tool .tl-head { color: #bbb; }
    .tl-block.tool .tl-cmd { color: #bbb; font-family: ui-monospace, SF Mono, Menlo, monospace; margin-top: 2px; word-break: break-all; }
    .tl-block.tool .tl-output { color: #9ef0aa; margin: 4px 0 0; white-space: pre-wrap; max-height: 160px; overflow-y: auto; background: #0c0c10; padding: 6px; border-radius: 4px; font-family: ui-monospace, SF Mono, Menlo, monospace; }
    .tl-block.tool .tl-output.err { color: #f09494; }
    .raw-events { margin: 6px 0; font-size: 12px; }
    .raw-events summary { cursor: pointer; color: #9ec5ff; padding: 2px 0; }
    .raw-events .raw-list { background: #0c0c10; border: 1px solid #292932; border-radius: 4px; max-height: 220px; overflow-y: auto; margin-top: 4px; }
    .raw-events .raw-row { border-bottom: 1px solid #1a1c26; padding: 4px 8px; cursor: pointer; }
    .raw-events .raw-row .raw-type { color: #9ec5ff; font-family: ui-monospace, SF Mono, Menlo, monospace; }
    .raw-events .raw-row .raw-time { opacity: 0.5; font-family: ui-monospace, SF Mono, Menlo, monospace; margin-right: 8px; }
    .raw-events .raw-row pre { background: #000; padding: 6px; border-radius: 3px; font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; margin: 4px 0 0; display: none; }
    .raw-events .raw-row.open pre { display: block; }
    .phases { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 16px; }
    .phase-pill { background: #1f2030; padding: 4px 10px; border-radius: 999px; font-size: 12px; }
    .phase-pill.active { background: #3d4e6b; color: #fff; }
    .runs-list { list-style: none; padding: 0; }
    .runs-list li { padding: 10px; border-bottom: 1px solid #222; display: flex; justify-content: space-between; }
    button { background: #2d2f3b; color: #e9e9ee; border: 1px solid #3a3c4a; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #3a3c4a; }
  </style>
</head>
<body>
  <header>
    <strong>agent-runner</strong>
    <span id="run-title" style="opacity:0.7">connecting…</span>
    <span id="timer" style="margin-left:auto; opacity:0.6"></span>
  </header>
  <main>
    <div id="phases" class="phases"></div>
    <div id="grid" class="grid"></div>
  </main>
  <script type="module" src="/_runner/client.js"></script>
</body>
</html>`;

const STATIC_CLIENT_JS = `// agent-runner lite client.
const params = new URLSearchParams(location.search);
const path = location.pathname;
const runIdMatch = path.match(/^\\/run\\/([^/]+)/);
const runListMatch = path.match(/^\\/runs\\/?$/);

const grid = document.getElementById("grid");
const phasesEl = document.getElementById("phases");
const runTitle = document.getElementById("run-title");
const timerEl = document.getElementById("timer");

const agents = new Map();
const phases = [];
let startedAt = null;

if (runListMatch) {
  fetch("/api/runs").then(r => r.json()).then(rows => {
    runTitle.textContent = "history (" + rows.length + " runs)";
    const ul = document.createElement("ul");
    ul.className = "runs-list";
    for (const row of rows) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const a = document.createElement("a");
      a.href = "/run/" + row.runId;
      a.textContent = (row.meta && row.meta.workflowName) || row.runId;
      left.appendChild(a);
      const desc = document.createElement("div");
      desc.style.opacity = "0.6";
      desc.style.fontSize = "12px";
      desc.textContent = (row.meta && row.meta.workflowDescription) || "";
      left.appendChild(desc);
      const right = document.createElement("div");
      right.textContent = row.result && row.result.ok === true ? "ok" :
                          row.result && row.result.ok === false ? "fail" : "?";
      right.style.opacity = "0.7";
      li.appendChild(left); li.appendChild(right);
      ul.appendChild(li);
    }
    grid.replaceWith(ul);
  });
} else if (runIdMatch) {
  const runId = runIdMatch[1];
  runTitle.textContent = "run " + runId.slice(0, 8);
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/run/" + encodeURIComponent(runId));
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "event") handle(msg.event);
    else if (msg.type === "snapshot.begin") { /* clearing */ }
    else if (msg.type === "snapshot.end") { /* live now */ }
  };
  setInterval(() => {
    if (!startedAt) return;
    const ms = Date.now() - startedAt;
    const s = Math.floor(ms / 1000);
    timerEl.textContent = Math.floor(s / 60) + "m " + (s % 60) + "s";
  }, 250);
} else {
  runTitle.textContent = "navigate to /run/<id> or /runs";
}

function handle(ev) {
  if (ev.kind === "workflow.start") {
    startedAt = ev.t;
    runTitle.textContent = (ev.meta && ev.meta.name) || ev.workflowPath;
    if (ev.meta && ev.meta.phases) {
      for (const p of ev.meta.phases) {
        phases.push(p.title);
        const pill = document.createElement("div");
        pill.className = "phase-pill";
        pill.textContent = p.title;
        pill.dataset.phase = p.title;
        phasesEl.appendChild(pill);
      }
    }
  } else if (ev.kind === "phase.mark") {
    for (const el of phasesEl.children) {
      el.classList.toggle("active", el.dataset.phase === ev.title);
    }
  } else if (ev.kind === "agent.start") {
    const card = document.createElement("div");
    card.className = "card";
    card.id = "a-" + ev.agentId;
    const status = document.createElement("span");
    status.className = "status running";
    status.textContent = "running";
    const head = document.createElement("h3");
    head.textContent = ev.label || ev.agentId.slice(0,8);
    head.appendChild(status);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (ev.phase ? "[" + ev.phase + "] " : "") + ev.cwd;
    const timeline = document.createElement("div");
    timeline.className = "timeline";
    const rawDetails = document.createElement("details");
    rawDetails.className = "raw-events";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "raw events (0)";
    const rawList = document.createElement("div");
    rawList.className = "raw-list";
    rawDetails.append(rawSummary, rawList);
    card.append(head, meta, timeline, rawDetails);
    grid.appendChild(card);
    // textParts / reasoningParts keyed by partID; tools keyed by callID.
    // Each block carries its ordinal so insertOrdered() can keep the
    // timeline in opencode arrival order.
    agents.set(ev.agentId, {
      card, status, timeline,
      textParts: new Map(), reasoningParts: new Map(), tools: new Map(),
      rawDetails, rawSummary, rawList, rawCount: 0,
    });
  } else if (ev.kind === "agent.token") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    let block = a.textParts.get(ev.partID);
    if (!block) {
      block = makeTextBlock(ev.ordinal);
      a.textParts.set(ev.partID, block);
      insertOrdered(a.timeline, block.el, ev.ordinal);
    }
    block.body.textContent += ev.delta;
    block.body.scrollTop = block.body.scrollHeight;
  } else if (ev.kind === "agent.reasoning") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    let block = a.reasoningParts.get(ev.partID);
    if (!block) {
      block = makeReasoningBlock(ev.ordinal);
      a.reasoningParts.set(ev.partID, block);
      insertOrdered(a.timeline, block.el, ev.ordinal);
    }
    block.body.textContent += ev.delta;
    block.body.scrollTop = block.body.scrollHeight;
    block.head.textContent = "thinking ";
    const ord = document.createElement("span");
    ord.className = "tl-ord";
    ord.textContent = "#" + ev.ordinal + " · " + block.body.textContent.length.toLocaleString() + " chars";
    block.head.appendChild(ord);
  } else if (ev.kind === "agent.raw") {
    const a = agents.get(ev.agentId);
    if (a) appendRawEvent(a, ev);
  } else if (ev.kind === "agent.tool.start") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    const block = makeToolBlock(ev.ordinal, ev.tool, ev.input);
    a.tools.set(ev.callID, block);
    insertOrdered(a.timeline, block.el, ev.ordinal);
  } else if (ev.kind === "agent.tool.result") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    const block = a.tools.get(ev.callID);
    if (!block) return;
    block.el.classList.add(ev.status === "error" ? "error" : "completed");
    const outEl = document.createElement("pre");
    outEl.className = "tl-output" + (ev.status === "error" ? " err" : "");
    const body = ev.status === "error"
      ? (ev.error || "(error)")
      : (ev.output != null ? String(ev.output) : "(ok)");
    outEl.textContent = body.length > 4000 ? body.slice(0, 4000) + "\\n…[truncated " + (body.length - 4000) + " chars]" : body;
    block.el.appendChild(outEl);
    if (ev.elapsedMs != null) {
      const meta = block.el.querySelector(".tl-ord");
      if (meta) meta.textContent = "#" + block.ordinal + " · " + ev.elapsedMs + "ms";
    }
  } else if (ev.kind === "agent.end") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    a.status.textContent = ev.ok ? "ok" : (ev.reason || "fail");
    a.status.className = "status " + (ev.ok ? "ok" : "fail");
    // Backfill the LAST text part with the canonical assembled text from
    // SessionTracker.finalText() if any stream deltas were dropped. Tool
    // inputs/outputs are already inline within their timeline slots.
    if (ev.rawText && a.textParts.size > 0) {
      let last = null;
      let lastOrd = -1;
      a.textParts.forEach((blk, _id) => {
        if (blk.ordinal > lastOrd) { lastOrd = blk.ordinal; last = blk; }
      });
      if (last && last.body.textContent.length < ev.rawText.length) {
        last.body.textContent = ev.rawText;
      }
    }
  } else if (ev.kind === "workflow.end") {
    runTitle.textContent += ev.ok ? "  •  ok" : "  •  FAILED";
  } else if (ev.kind === "workflow.log") {
    console.log("[log]", ev.msg, ev.meta);
  }
}

// Walk the timeline children and insert the new block before the first
// existing block with a higher ordinal. Ordinals are stable per partID/callID,
// so updates never need to reorder.
function insertOrdered(container, el, ordinal) {
  el.dataset.ordinal = String(ordinal);
  const kids = container.children;
  for (let i = 0; i < kids.length; i++) {
    const o = Number(kids[i].dataset.ordinal || "0");
    if (o > ordinal) { container.insertBefore(el, kids[i]); return; }
  }
  container.appendChild(el);
}

function makeTextBlock(ordinal) {
  const el = document.createElement("div");
  el.className = "tl-block text";
  const head = document.createElement("div");
  head.className = "tl-head";
  const label = document.createElement("span");
  label.textContent = "message";
  const ord = document.createElement("span");
  ord.className = "tl-ord";
  ord.textContent = "#" + ordinal;
  head.append(label, ord);
  const body = document.createElement("pre");
  body.className = "tl-body";
  el.append(head, body);
  return { el, head, body, ordinal };
}

function makeReasoningBlock(ordinal) {
  const el = document.createElement("div");
  el.className = "tl-block reasoning";
  const head = document.createElement("div");
  head.className = "tl-head";
  head.textContent = "thinking ";
  const ord = document.createElement("span");
  ord.className = "tl-ord";
  ord.textContent = "#" + ordinal;
  head.append(ord);
  const body = document.createElement("pre");
  body.className = "tl-body";
  el.append(head, body);
  // Click the heading to expand/collapse the chain-of-thought body.
  head.addEventListener("click", () => el.classList.toggle("open"));
  return { el, head, body, ordinal };
}

function makeToolBlock(ordinal, tool, input) {
  const el = document.createElement("div");
  el.className = "tl-block tool";
  const head = document.createElement("div");
  head.className = "tl-head";
  const label = document.createElement("span");
  label.textContent = tool;
  const ord = document.createElement("span");
  ord.className = "tl-ord";
  ord.textContent = "#" + ordinal + " · running…";
  head.append(label, ord);
  const cmd = document.createElement("div");
  cmd.className = "tl-cmd";
  if (tool && tool.toLowerCase() === "bash" && input && input.command) {
    cmd.textContent = "$ " + String(input.command);
  } else {
    let s;
    try { s = JSON.stringify(input); } catch (_e) { s = String(input); }
    cmd.textContent = s && s.length > 240 ? s.slice(0, 240) + "…" : (s || "");
  }
  el.append(head, cmd);
  return { el, head, cmd, ordinal };
}

function appendRawEvent(a, ev) {
  // Cap at 2,000 entries to keep the DOM bounded — long runs can produce
  // hundreds of thousands of message.part.updated ticks.
  if (a.rawList.children.length >= 2000) {
    a.rawList.removeChild(a.rawList.firstChild);
  }
  const row = document.createElement("div");
  row.className = "raw-row";
  const time = new Date(ev.t).toISOString().slice(11, 23);
  const timeEl = document.createElement("span");
  timeEl.className = "raw-time";
  timeEl.textContent = time;
  const typeEl = document.createElement("span");
  typeEl.className = "raw-type";
  typeEl.textContent = ev.evType;
  const head = document.createElement("div");
  head.append(timeEl, typeEl);
  const pre = document.createElement("pre");
  try { pre.textContent = JSON.stringify(ev.payload, null, 2); }
  catch (e) { pre.textContent = String(ev.payload); }
  row.append(head, pre);
  row.addEventListener("click", () => row.classList.toggle("open"));
  a.rawList.appendChild(row);
  a.rawCount += 1;
  a.rawSummary.textContent = "raw events (" + a.rawCount.toLocaleString() + ")";
}
`;

export interface HttpServerOptions {
  port: number;
  runsDir: string;
  webDistDir?: string; // optional path to Vite-built React UI; falls back to STATIC.
}

// Control surface the HTTP server uses to act on a live run on behalf of the
// UI: per-agent abort/retry and permission replies. cli/run.ts populates this
// once it has built a RunContext + OpencodeDriver.
export interface RunControlSurface {
  agentControls: Map<string, { abort: () => Promise<void>; retry: () => Promise<void>; ended: boolean }>;
  replyPermission: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => Promise<{ ok: boolean; error?: string }>;
}

export interface RunningServer {
  bus: EventBus;
  hub: WsHub;
  server: Server<{ runId: string; unsub?: () => void }>;
  url: string;
  registerRun: (runId: string, surface: RunControlSurface) => () => void;
  close: () => void;
}

export async function startHttpServer(
  opts: HttpServerOptions,
  bus: EventBus,
): Promise<RunningServer> {
  const hub = new WsHub();
  hub.attach(bus);
  const index = new RunIndex(opts.runsDir);
  const runs = new Map<string, RunControlSurface>();
  const webDist = opts.webDistDir ?? resolveDefaultWebDist();

  type Sock = ServerWebSocket<{ runId: string; unsub?: () => void }>;
  const server = Bun.serve<{ runId: string; unsub?: () => void }>({
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket upgrade.
      const wsMatch = url.pathname.match(/^\/ws\/run\/([^/]+)$/);
      if (wsMatch) {
        const runId = decodeURIComponent(wsMatch[1]!);
        const upgraded = srv.upgrade(req, { data: { runId } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade failed", { status: 426 });
      }

      // API: list runs.
      if (url.pathname === "/api/runs") {
        return index.list().then(
          (rows) =>
            new Response(JSON.stringify(rows), {
              headers: { "content-type": "application/json" },
            }),
        );
      }

      // API: get a run's events (NDJSON).
      const evMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/events$/);
      if (evMatch) {
        const runId = decodeURIComponent(evMatch[1]!);
        return readEventsFile(index.eventsPath(runId)).then(
          (evs) => new Response(JSON.stringify(evs), {
            headers: { "content-type": "application/json" },
          }),
          () => new Response("[]", { headers: { "content-type": "application/json" } }),
        );
      }

      // Static + SPA routing.
      if (webDist && existsSync(webDist)) {
        // Serve compiled Vite output.
        const candidate = url.pathname === "/" ? "/index.html" : url.pathname;
        const filePath = join(webDist, candidate);
        if (existsSync(filePath) && !filePath.endsWith(".html")) {
          return new Response(Bun.file(filePath));
        }
        // SPA fallback.
        const fallback = join(webDist, "index.html");
        if (existsSync(fallback)) return new Response(Bun.file(fallback));
      }

      if (url.pathname === "/_runner/client.js") {
        return new Response(STATIC_CLIENT_JS, {
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response(STATIC_INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      open(ws: Sock) {
        const unsub = hub.subscribe(ws as unknown as { send(t: string): void; readyState: number }, ws.data.runId);
        ws.data.unsub = unsub;
        ws.send(JSON.stringify({ type: "snapshot.begin", runId: ws.data.runId }));
        // Replay history.
        readEventsFile(index.eventsPath(ws.data.runId))
          .then((evs) => {
            for (const ev of evs) {
              ws.send(JSON.stringify({ type: "event", event: ev }));
            }
            ws.send(JSON.stringify({ type: "snapshot.end" }));
          })
          .catch(() => {
            ws.send(JSON.stringify({ type: "snapshot.end" }));
          });
      },
      async message(ws: Sock, message: string | Uint8Array) {
        let payload: {
          type?: string;
          agentId?: string;
          requestID?: string;
          reply?: "once" | "always" | "reject";
          replyTo?: string;
        };
        try {
          payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        } catch {
          return;
        }
        const surface = runs.get(ws.data.runId);
        // Helper for ack/error responses keyed by replyTo (a UI-supplied
        // correlation id). The UI doesn't strictly need this today but it
        // costs nothing and the permission-reply path is the natural first
        // consumer once the UI wants to disable a button until ack.
        const respond = (body: Record<string, unknown>): void => {
          if (payload.replyTo) body.replyTo = payload.replyTo;
          try { ws.send(JSON.stringify(body)); } catch { /* ignore */ }
        };
        if (payload.type === "abort") {
          // Global abort: aborts every still-running agent in this run.
          if (surface) {
            for (const ctrl of surface.agentControls.values()) {
              if (!ctrl.ended) {
                try { await ctrl.abort(); } catch { /* best effort */ }
              }
            }
          }
          respond({ type: "abort.ack" });
        } else if (payload.type === "abort-agent" && payload.agentId) {
          const ctrl = surface?.agentControls.get(payload.agentId);
          if (ctrl && !ctrl.ended) {
            try { await ctrl.abort(); } catch { /* best effort */ }
            respond({ type: "abort-agent.ack", agentId: payload.agentId });
          } else {
            respond({ type: "abort-agent.error", agentId: payload.agentId, error: ctrl ? "already ended" : "unknown agent" });
          }
        } else if (payload.type === "retry-agent" && payload.agentId) {
          const ctrl = surface?.agentControls.get(payload.agentId);
          if (ctrl) {
            try { await ctrl.retry(); } catch (err) {
              respond({ type: "retry-agent.error", agentId: payload.agentId, error: (err as Error).message });
              return;
            }
            respond({ type: "retry-agent.ack", agentId: payload.agentId });
          } else {
            respond({ type: "retry-agent.error", agentId: payload.agentId, error: "unknown agent" });
          }
        } else if (payload.type === "permission-reply" && payload.requestID && payload.reply) {
          if (!surface) {
            respond({ type: "permission-reply.error", requestID: payload.requestID, error: "run not active" });
            return;
          }
          const r = await surface.replyPermission(payload.requestID, payload.reply);
          if (r.ok) respond({ type: "permission-reply.ack", requestID: payload.requestID });
          else respond({ type: "permission-reply.error", requestID: payload.requestID, error: r.error ?? "unknown error" });
        }
      },
      close(ws: Sock) {
        if (ws.data.unsub) ws.data.unsub();
      },
    },
  });

  return {
    bus,
    hub,
    server,
    url: `http://${server.hostname}:${server.port}`,
    registerRun: (runId, surface) => {
      runs.set(runId, surface);
      return () => {
        if (runs.get(runId) === surface) runs.delete(runId);
      };
    },
    close: () => {
      hub.detach();
      server.stop(true);
    },
  };
}

function resolveDefaultWebDist(): string | null {
  // src/server/http.ts -> ../../web/dist when running from source.
  // dist/cli/index.js -> ../web/dist when running compiled.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "web", "dist"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
