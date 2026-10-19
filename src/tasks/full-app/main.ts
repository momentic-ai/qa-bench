import {
  claudeAgent,
  claudeLocalAgent,
} from "../../agents/claude/claude-agent";
import { codexAgent, codexLocalAgent } from "../../agents/codex/codex-agent";
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
        codex: codexAgent,
        "codex-local": codexLocalAgent,
        claude: claudeAgent,
        "claude-local": claudeLocalAgent,
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
