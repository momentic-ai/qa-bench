import { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { FINDINGS_TOOLS, FindingsStore } from "../codex/findings-store";

export function reportingServer(
  store: FindingsStore,
): McpSdkServerConfigWithInstance {
  const server = new McpServer(
    { name: "eval-reporting", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: FINDINGS_TOOLS.map(({ type: _, ...tool }) => tool),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      await store.handleTool(params.name, params.arguments);
      return { content: [{ type: "text", text: "Saved." }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err) }] };
    }
  });
  return { type: "sdk", name: "reporting", instance: server };
}
