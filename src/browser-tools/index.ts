import { AgentBrowser } from "./drivers/agent-browser";
import { E2E } from "./drivers/e2e";
import { PlaywrightMcp } from "./drivers/playwright-mcp";
import { BrowserTool } from "./testing-browser";

const BROWSER_TOOLS = {
  "playwright-mcp": PlaywrightMcp,
  "agent-browser": AgentBrowser,
  e2e: E2E,
} satisfies Record<BrowserTool, unknown>;

export function testingBrowser(tool: BrowserTool) {
  return BROWSER_TOOLS[tool];
}
