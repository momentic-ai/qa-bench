import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";

import { FINDINGS_TOOLS, FindingsStore } from "../codex/findings-store";

const RequestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

export async function startReportingServer(store: FindingsStore) {
  const endpoint = `/${randomUUID()}`;
  const server = createServer(async (request, response) => {
    if (request.url !== endpoint || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let id: string | number | undefined;
    try {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1_000_000) throw new Error("Request too large.");
      }
      const message = RequestSchema.parse(JSON.parse(body));
      id = message.id;
      if (id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "eval-reporting", version: "1.0.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: FINDINGS_TOOLS.map(({ type: _, ...tool }) => tool),
          };
          break;
        case "tools/call": {
          const call = z
            .object({ name: z.string(), arguments: z.unknown() })
            .parse(message.params);
          try {
            await store.handleTool(call.name, call.arguments);
            result = { content: [{ type: "text", text: "Saved." }] };
          } catch (err) {
            result = {
              isError: true,
              content: [{ type: "text", text: String(err) }],
            };
          }
          break;
        }
        default:
          throw new Error(`Unsupported MCP method: ${message.method}`);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (err) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32600, message: String(err) },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing reporting server address.");
  return {
    url: `http://127.0.0.1:${address.port}${endpoint}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
