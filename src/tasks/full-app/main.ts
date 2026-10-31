import { claudeAgent } from "../../agents/claude/claude-agent";
import { codexAgent } from "../../agents/codex/codex-agent";
import { devinQaAgent } from "../../agents/devin/qa-agent";
import { moAgent } from "../../agents/mo/mo-agent";
import { selectComparisonFixtures } from "../../evals/fixture-selection";
import { createRunId } from "../../evals/report-files";
import { runFullAppFixtures } from "../../evals/run-full-app";
import { AgentSchema } from "../../evals/scores";
import { createFullAppGrader } from "./grade";
import { FullAppOptions } from "./options";

export async function runFullAppEval(options: FullAppOptions): Promise<void> {
  const agent = AgentSchema.parse(options.agent);
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
          options.codexModel,
          options.preventCheating,
        ),
        "claude-playwright-mcp": claudeAgent(
          options.browser,
          "playwright-mcp",
          options.claudeModel,
        ),
        "codex-agent-browser": codexAgent(
          options.browser,
          "agent-browser",
          options.codexModel,
        ),
        "claude-agent-browser": claudeAgent(
          options.browser,
          "agent-browser",
          options.claudeModel,
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
