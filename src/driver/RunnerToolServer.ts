import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServerLowLevel } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunContext } from "../primitives/runtime.ts";
import { nowMs } from "../bus/events.ts";

// In-process HTTP server that exposes ctx.runnerTools (populated by the
// workflow's defineTool() calls) to opencode through TWO endpoints:
//
//   POST <base>/rpc/call    -- plain JSON-RPC used by the auto-generated
//                              opencode plugin file. The plugin tool's
//                              `execute` callback POSTs { name, args } here
//                              and forwards the JSON result to opencode. This
//                              is the PRIMARY path now: opencode plugins
//                              register tools under their bare name (no
//                              MCP server prefix), so the model sees
//                              `report_file_status` instead of
//                              `__runner___report_file_status`.
//
//   POST <base>/mcp         -- legacy MCP StreamableHTTP transport. Kept for
//                              ad-hoc external MCP clients (debugging,
//                              inspector tooling). agent_runner itself no
//                              longer wires this into opencode by default.
//
// Both endpoints dispatch into the same `ctx.runnerTools` map so a workflow's
// defineTool() handlers work the same way no matter which path was used.
//
// We use the low-level MCP Server class (not McpServer) deliberately: McpServer
// only accepts Zod schemas for tool inputs, while workflows author plain
// JSON Schema. The low-level path lets us forward the workflow's schema
// verbatim and rely on opencode/the model to honour it.
//
// Stateless mode: a fresh Server + Transport per MCP HTTP request. opencode's
// MCP client re-initializes each request, which is wasteful but cheap on
// localhost. Stateful mode would be slightly faster but adds session-ID
// bookkeeping for no real benefit here.

export interface RunnerToolServerHandle {
  // Base URL of the server, e.g. http://127.0.0.1:54321
  baseUrl: string;
  // Full URL of the legacy MCP endpoint (baseUrl + "/mcp").
  mcpUrl: string;
  // Full URL of the plain JSON-RPC endpoint (baseUrl + "/rpc/call").
  // The auto-generated opencode plugin file embeds this URL.
  rpcUrl: string;
  close: () => Promise<void>;
}

// Read the full request body as UTF-8. Tool handlers can produce large
// outputs but the requests themselves are small (just { name, args }).
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      chunks += chunk;
    });
    req.on("end", () => resolve(chunks));
    req.on("error", (err) => reject(err));
  });
}

// Dispatch a tool call by name. Used by BOTH the MCP and the plain-RPC
// endpoints so they stay in lockstep behaviourally.
async function dispatchToolCall(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const def = ctx.runnerTools.get(name);
  if (!def) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }
  try {
    const result = await def.handler(args);
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    ctx.bus.emit({
      kind: "workflow.log",
      runId: ctx.runId,
      msg: `runner-tool ${name} threw: ${msg}`,
      t: nowMs(),
    });
    return { ok: false, error: msg };
  }
}

export async function startRunnerToolServer(ctx: RunContext): Promise<RunnerToolServerHandle> {
  function buildMcpServer(): McpServerLowLevel {
    const server = new McpServerLowLevel(
      { name: "agent-runner-tools", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(ctx.runnerTools.values()).map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }));
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const input = (request.params.arguments ?? {}) as Record<string, unknown>;
      const dispatched = await dispatchToolCall(ctx, name, input);
      if (!dispatched.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Tool ${name} failed: ${dispatched.error}` }],
        };
      }
      const result = dispatched.result;
      // Pass-through: if the handler returned an MCP-shaped result with
      // its own content array (e.g. the workflow wants control over the
      // text the model sees), use it. Otherwise JSON-stringify the value
      // — the agent prompt explains the schema, so structured text is
      // the cleanest default.
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content)
      ) {
        return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    });
    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      // GET would normally serve the SSE notification stream; we don't
      // emit server-initiated notifications, so reject. DELETE terminates
      // a session — irrelevant in stateless mode.
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }

    const url = req.url ?? "";

    // Plain JSON-RPC endpoint used by the auto-generated opencode plugin.
    if (url.startsWith("/rpc/call")) {
      try {
        const body = await readBody(req);
        const parsed = body.length > 0 ? JSON.parse(body) : {};
        const name = typeof parsed.name === "string" ? parsed.name : "";
        const args =
          parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
            ? (parsed.args as Record<string, unknown>)
            : {};
        if (!name) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "missing `name` field" }));
          return;
        }
        const dispatched = await dispatchToolCall(ctx, name, args);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(dispatched));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.bus.emit({
          kind: "workflow.log",
          runId: ctx.runId,
          msg: `RunnerToolServer /rpc/call failed: ${msg}`,
          t: nowMs(),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      }
      return;
    }

    // Legacy MCP StreamableHTTP transport.
    if (url.startsWith("/mcp")) {
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.bus.emit({
          kind: "workflow.log",
          runId: ctx.runId,
          msg: `RunnerToolServer /mcp request failed: ${msg}`,
          t: nowMs(),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        }
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });

  const port: number = await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address() as AddressInfo | string | null;
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("RunnerToolServer: could not determine listen address"));
      }
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    rpcUrl: `${baseUrl}/rpc/call`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
