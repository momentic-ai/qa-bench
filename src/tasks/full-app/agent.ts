import { browserUseAgent } from "../../agents/browser-use/agent";
import { claudeAgent } from "../../agents/claude/claude-agent";
import { codexAgent } from "../../agents/codex/codex-agent";
import { devinQaAgent } from "../../agents/devin/qa-agent";
import { moAgent } from "../../agents/mo/mo-agent";
import { EvalAgentDefinition } from "../../agents/types";
import { Agent } from "../../evals/scores";
import { FullAppOptions } from "./options";

export function createFullAppAgent(
  agent: Agent,
  options: Pick<
    FullAppOptions,
    "browser" | "codexModel" | "claudeModel" | "preventCheating" | "recordBugs"
  >,
): EvalAgentDefinition {
  switch (agent) {
    case "mo":
      return moAgent;
    case "devin-qa":
      return devinQaAgent;
    case "browser-use":
      return browserUseAgent({
        preventCheating: options.preventCheating,
        recordBugs: options.recordBugs,
      });
    case "codex-playwright-mcp":
    case "codex-agent-browser":
    case "codex-e2e":
      return codexAgent(
        options.browser,
        agent === "codex-e2e"
          ? "e2e"
          : agent === "codex-agent-browser"
            ? "agent-browser"
            : "playwright-mcp",
        options.codexModel,
        options.preventCheating,
        options.recordBugs,
      );
    case "claude-playwright-mcp":
    case "claude-agent-browser":
    case "claude-e2e":
      return claudeAgent(
        options.browser,
        agent === "claude-e2e"
          ? "e2e"
          : agent === "claude-agent-browser"
            ? "agent-browser"
            : "playwright-mcp",
        options.claudeModel,
        options.preventCheating,
        options.recordBugs,
      );
  }
}
