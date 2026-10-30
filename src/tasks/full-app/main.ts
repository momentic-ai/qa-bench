import { claudeAgent } from "../../agents/claude/claude-agent";
import { codexAgent } from "../../agents/codex/codex-agent";
import { devinQaAgent } from "../../agents/devin/qa-agent";
import { moAgent } from "../../agents/mo/mo-agent";
import { ClaudeModel, CodexModel } from "../../evals/agent";
import { selectComparisonFixtures } from "../../evals/fixture-selection";
import { createRunId } from "../../evals/report-files";
import { runFullAppFixtures } from "../../evals/run-full-app";
import { AgentSchema } from "../../evals/scores";
import { createFullAppGrader } from "./grade";
import { FullAppOptions } from "./options";

export async function runFullAppEval(options: FullAppOptions): Promise<void> {
  const agent = AgentSchema.parse(options.agent);
  const codexModel = options.model as CodexModel | undefined;
  const claudeModel = options.model as ClaudeModel | undefined;
  const fixtures = await selectComparisonFixtures(options.fixtures);
  const runId = createRunId();
  const grader = createFullAppGrader(
    agent,
    fixtures,
    options.outputDirectory,
    runId,
  );
  try {
    await runFullAppFixtures({
      agent: {
        mo: moAgent,
        "devin-qa": devinQaAgent,
        "codex-playwright-mcp": codexAgent(
          options.browser,
          "playwright-mcp",
          codexModel,
        ),
        "claude-playwright-mcp": claudeAgent(
          options.browser,
          "playwright-mcp",
          claudeModel,
        ),
        "codex-agent-browser": codexAgent(
          options.browser,
          "agent-browser",
          codexModel,
        ),
        "claude-agent-browser": claudeAgent(
          options.browser,
          "agent-browser",
          claudeModel,
        ),
      }[agent],
      options,
      runId,
      fixtures,
      onComplete: (fixture, signal) =>
        grader.onComplete(fixture, runId, signal),
    });
  } finally {
    await grader.save();
  }
}
