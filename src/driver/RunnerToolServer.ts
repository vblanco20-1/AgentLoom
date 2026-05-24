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

// In-process MCP HTTP server. Exposes ctx.runnerTools (populated by the
// workflow's defineTool() calls) under MCP's tools/list + tools/call so
// opencode — pointed at this server via its `mcp` remote config — can
// show the tools to the sub-agent and dispatch invocations back into the
// runner's JS handlers.
//
// We use the low-level Server class (not McpServer) deliberately: McpServer
// only accepts Zod schemas for tool inputs, while workflows author plain
// JSON Schema. The low-level path lets us forward the workflow's schema
// verbatim and rely on opencode/the model to honour it.
//
// Stateless mode: a fresh Server + Transport per HTTP request. opencode's
// MCP client re-initializes each request, which is wasteful but cheap on
// localhost. Stateful mode would be slightly faster but adds session-ID
// bookkeeping for no real benefit here.

export interface RunnerToolServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startRunnerToolServer(ctx: RunContext): Promise<RunnerToolServerHandle> {
  function buildServer(): McpServerLowLevel {
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
      const def = ctx.runnerTools.get(name);
      if (!def) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        };
      }
      const input = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await def.handler(input);
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
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        ctx.bus.emit({
          kind: "workflow.log",
          runId: ctx.runId,
          msg: `runner-tool ${name} threw: ${msg}`,
          t: nowMs(),
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Tool ${name} failed: ${msg}` }],
        };
      }
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
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Not found" },
          id: null,
        }),
      );
      return;
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
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
        msg: `RunnerToolServer request failed: ${msg}`,
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

  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
