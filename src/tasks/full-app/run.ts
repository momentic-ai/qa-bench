import { selectComparisonFixtures } from "../../evals/fixture-selection";
import { createRunId } from "../../evals/report-files";
import { AgentSchema } from "../../evals/scores";
import { createFullAppAgent } from "./agent";
import { FullAppGrader } from "./grader";
import { FullAppOptions } from "./options";
import { runFullAppFixtures } from "./run-fixtures";

export async function runFullAppEval(options: FullAppOptions): Promise<void> {
  const agent = AgentSchema.parse(options.agent);
  const fixtures = await selectComparisonFixtures(options.fixtures);
  const runId = createRunId();
  const grader = new FullAppGrader(
    agent,
    fixtures,
    options.outputDirectory,
    runId,
  );
  try {
    await runFullAppFixtures({
      agent: createFullAppAgent(agent, options),
      options,
      runId,
      fixtures,
      onComplete: (fixture, signal) => grader.grade(fixture, runId, signal),
    });
  } finally {
    await grader.save();
  }
}
