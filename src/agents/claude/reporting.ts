import { FINDINGS_TOOLS, FindingsStore } from "../codex/findings-store";
import { ToolSchema, sdkMcpServer } from "./sdk-mcp";

export function reportingServer(store: FindingsStore) {
  return sdkMcpServer({
    name: "reporting",
    listTools: async () =>
      FINDINGS_TOOLS.map(({ type: _, ...tool }) => ToolSchema.parse(tool)),
    async callTool(call) {
      try {
        await store.handleTool(call.name, call.arguments);
        return { content: [{ type: "text", text: "Saved." }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: String(err) }],
        };
      }
    },
  });
}
