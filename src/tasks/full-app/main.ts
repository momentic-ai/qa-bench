import { claudeAgent } from "../../agents/claude/claude-agent";
import { codexAgent } from "../../agents/codex/codex-agent";
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
        "codex-playwright-mcp": codexAgent(options.browser),
        "claude-playwright-mcp": claudeAgent(options.browser),
        "codex-agent-browser": codexAgent(options.browser, "agent-browser"),
        "claude-agent-browser": claudeAgent(options.browser, "agent-browser"),
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
