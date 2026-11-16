import { codexRunner } from "../codex/runner";
import { AgentReportReader } from "../report-reader";

export const claudeRunner: AgentReportReader = {
  ...codexRunner,
  name: "claude-playwright-mcp",
  reportDirectory: "claude-playwright-mcp",
};
