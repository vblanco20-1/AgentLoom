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
    .reasoning { margin: 6px 0; font-size: 12px; }
    .reasoning summary { cursor: pointer; color: #b6a4ff; padding: 2px 0; }
    .reasoning pre { background: #0c0c10; padding: 6px 8px; border-radius: 4px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; color: #b6a4ff; opacity: 0.85; margin: 4px 0 0; }
    .raw-events { margin: 6px 0; font-size: 12px; }
    .raw-events summary { cursor: pointer; color: #9ec5ff; padding: 2px 0; }
    .raw-events .raw-list { background: #0c0c10; border: 1px solid #292932; border-radius: 4px; max-height: 220px; overflow-y: auto; margin-top: 4px; }
    .raw-events .raw-row { border-bottom: 1px solid #1a1c26; padding: 4px 8px; cursor: pointer; }
    .raw-events .raw-row .raw-type { color: #9ec5ff; font-family: ui-monospace, SF Mono, Menlo, monospace; }
    .raw-events .raw-row .raw-time { opacity: 0.5; font-family: ui-monospace, SF Mono, Menlo, monospace; margin-right: 8px; }
    .raw-events .raw-row pre { background: #000; padding: 6px; border-radius: 3px; font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; margin: 4px 0 0; display: none; }
    .raw-events .raw-row.open pre { display: block; }
    .tools { margin-top: 8px; font-size: 12px; color: #aaa; }
    .tool { background: #1a1c26; border-left: 3px solid #555; padding: 4px 8px; margin: 4px 0; border-radius: 0 4px 4px 0; }
    .tool.completed { border-left-color: #4ecb71; }
    .tool.error { border-left-color: #cb4e4e; }
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
    const reasoning = document.createElement("details");
    reasoning.className = "reasoning";
    reasoning.style.display = "none";
    const reasoningSummary = document.createElement("summary");
    reasoningSummary.textContent = "thinking";
    const reasoningPre = document.createElement("pre");
    reasoning.append(reasoningSummary, reasoningPre);
    const pre = document.createElement("pre");
    pre.dataset.role = "stream";
    const tools = document.createElement("div");
    tools.className = "tools";
    tools.dataset.role = "tools";
    const rawDetails = document.createElement("details");
    rawDetails.className = "raw-events";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "raw events (0)";
    const rawList = document.createElement("div");
    rawList.className = "raw-list";
    rawDetails.append(rawSummary, rawList);
    card.append(head, meta, reasoning, pre, tools, rawDetails);
    grid.appendChild(card);
    agents.set(ev.agentId, { card, status, pre, tools, reasoning, reasoningPre, reasoningSummary, rawDetails, rawSummary, rawList, rawCount: 0 });
  } else if (ev.kind === "agent.token") {
    const a = agents.get(ev.agentId);
    if (a) {
      a.pre.textContent += ev.delta;
      a.pre.scrollTop = a.pre.scrollHeight;
    }
  } else if (ev.kind === "agent.reasoning") {
    const a = agents.get(ev.agentId);
    if (a) {
      a.reasoning.style.display = "block";
      a.reasoningPre.textContent += ev.delta;
      a.reasoningPre.scrollTop = a.reasoningPre.scrollHeight;
      a.reasoningSummary.textContent = "thinking (" + a.reasoningPre.textContent.length.toLocaleString() + " chars)";
    }
  } else if (ev.kind === "agent.raw") {
    const a = agents.get(ev.agentId);
    if (a) appendRawEvent(a, ev);
  } else if (ev.kind === "agent.tool.start") {
    const a = agents.get(ev.agentId);
    if (!a) return;
    const t = document.createElement("div");
    t.className = "tool";
    t.id = "c-" + ev.agentId + "-" + ev.callID;
    t.textContent = ev.tool + ": " + JSON.stringify(ev.input).slice(0, 200);
    a.tools.appendChild(t);
  } else if (ev.kind === "agent.tool.result") {
    const t = document.getElementById("c-" + ev.agentId + "-" + ev.callID);
    if (t) {
      t.classList.add(ev.status === "error" ? "error" : "completed");
      t.textContent += "  →  " + (ev.status === "error" ? (ev.error || "err") : (ev.output ? ev.output.slice(0,200) : "(ok)"));
    }
  } else if (ev.kind === "agent.end") {
    const a = agents.get(ev.agentId);
    if (a) {
      a.status.textContent = ev.ok ? "ok" : (ev.reason || "fail");
      a.status.className = "status " + (ev.ok ? "ok" : "fail");
      // Backfill the streamed pre with the canonical full LLM output —
      // this is the assembled assistant text from every text part, even
      // if individual stream deltas were dropped. Tool inputs/outputs
      // remain in the dedicated tool list below.
      if (ev.rawText && ev.rawText.length > a.pre.textContent.length) {
        a.pre.textContent = ev.rawText;
        a.pre.scrollTop = a.pre.scrollHeight;
      }
    }
  } else if (ev.kind === "workflow.end") {
    runTitle.textContent += ev.ok ? "  •  ok" : "  •  FAILED";
  } else if (ev.kind === "workflow.log") {
    console.log("[log]", ev.msg, ev.meta);
  }
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

export interface RunningServer {
  bus: EventBus;
  hub: WsHub;
  server: Server<{ runId: string; unsub?: () => void }>;
  url: string;
  registerAbort: (runId: string, fn: () => Promise<void>) => () => void;
  close: () => void;
}

export async function startHttpServer(
  opts: HttpServerOptions,
  bus: EventBus,
): Promise<RunningServer> {
  const hub = new WsHub();
  hub.attach(bus);
  const index = new RunIndex(opts.runsDir);
  const aborts = new Map<string, Set<() => Promise<void>>>();
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
        let payload: { type?: string; agentId?: string };
        try {
          payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        } catch {
          return;
        }
        if (payload.type === "abort") {
          const set = aborts.get(ws.data.runId);
          if (set) {
            for (const fn of set) {
              try { await fn(); } catch {/* ignore */}
            }
          }
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
    registerAbort: (runId, fn) => {
      let set = aborts.get(runId);
      if (!set) { set = new Set(); aborts.set(runId, set); }
      set.add(fn);
      return () => set!.delete(fn);
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
