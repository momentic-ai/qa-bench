import {
  McpSdkServerConfigWithInstance,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const ListToolsSchema = z.object({ method: z.literal("tools/list") });
const CallToolSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: z
      .object({ "claudecode/toolUseId": z.string().optional() })
      .passthrough()
      .optional(),
  }),
});
export const ToolSchema = z
  .object({
    name: z.string(),
    inputSchema: z.object({ type: z.literal("object") }).passthrough(),
  })
  .passthrough();
export const ToolResultSchema = z
  .object({ content: z.array(z.object({ type: z.string() }).passthrough()) })
  .passthrough();

// The SDK's tool() takes zod shapes; these servers pass JSON Schemas through unchanged.
export function sdkMcpServer(options: {
  name: string;
  instructions?: string;
  timeout?: number;
  listTools(): Promise<z.infer<typeof ToolSchema>[]>;
  callTool(
    call: z.infer<typeof CallToolSchema>["params"],
  ): Promise<z.infer<typeof ToolResultSchema>>;
}): McpSdkServerConfigWithInstance {
  const config = createSdkMcpServer({
    name: options.name,
    instructions: options.instructions,
    tools: [],
  });
  config.instance.server.setRequestHandler(ListToolsSchema, async () => ({
    tools: await options.listTools(),
  }));
  config.instance.server.setRequestHandler(CallToolSchema, ({ params }) =>
    options.callTool(params),
  );
  return { ...config, timeout: options.timeout };
}
