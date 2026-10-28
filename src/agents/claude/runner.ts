import { BenchmarkAgent } from "../../evals/types";
import { codexRunner } from "../codex/runner";

export const claudeRunner: BenchmarkAgent = {
  ...codexRunner,
  name: "claude-playwright-mcp",
  reportDirectory: "claude-playwright-mcp",
};
