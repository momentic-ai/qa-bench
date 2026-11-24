import { selectComparisonFixtures } from "../../evals/fixture-selection";
import {
  createRunId,
  findLatestRun,
  findRequestedRun,
} from "../../evals/report-files";
import { AgentSchema, reportDirectory } from "../../evals/scores";
import { setupSandboxCleanup } from "../../fixtures/cleanup";
import { FullAppGrader } from "./grader";
import { FullAppOptions } from "./options";

export async function gradeFullAppEval(options: FullAppOptions): Promise<void> {
  const agent = AgentSchema.parse(options.agent);
  const fixtures = await selectComparisonFixtures(options.fixtures);
  const runs = await Promise.all(
    fixtures.map((fixture) =>
      options.runIds.length
        ? findRequestedRun(
            options.outputDirectory,
            agent,
            fixture.name,
            options.runIds,
          )
        : findLatestRun(options.outputDirectory, agent, fixture.name),
    ),
  );
  const unmatched = options.runIds.filter(
    (id) => !runs.some((run) => run?.runId === id),
  );
  if (unmatched.length > 0) {
    throw new Error(
      `No ${agent} reports for --run-id ${unmatched.join(", ")} among the selected fixtures in ${reportDirectory(agent, undefined, options.outputDirectory)}.`,
    );
  }
  const uncovered = fixtures.filter((_, index) => !runs[index]);
  if (uncovered.length > 0) {
    throw new Error(
      `No ${agent} reports for --run-id ${options.runIds.join(", ")} in ${uncovered.map((fixture) => fixture.name).join(", ")}; pass a run ID for every selected fixture.`,
    );
  }
  const grader = new FullAppGrader(
    agent,
    fixtures,
    options.outputDirectory,
    createRunId(),
  );
  const cleanup = setupSandboxCleanup();
  try {
    cleanup.signal.throwIfAborted();
    for (const [index, fixture] of fixtures.entries()) {
      await grader.grade(fixture, runs[index]?.runId, cleanup.signal);
    }
  } catch (error) {
    if (
      !cleanup.signal.aborted ||
      (error !== cleanup.signal.reason &&
        !(error instanceof Error && error.name === "AbortError"))
    )
      throw error;
  } finally {
    try {
      await grader.save();
    } finally {
      await cleanup.dispose();
    }
  }
}
