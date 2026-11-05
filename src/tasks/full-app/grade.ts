import { Codex } from "@openai/codex-sdk";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { selectComparisonFixtures } from "../../evals/fixture-selection";
import {
  claimReportRun,
  createRunId,
  findReportRun,
} from "../../evals/report-files";
import { setupSandboxCleanup } from "../../evals/sandbox";
import {
  Agent,
  AgentSchema,
  Score,
  reportDirectory,
  writeScores,
} from "../../evals/scores";
import { Fixture } from "../../evals/types";
import { gradeFixture } from "../../grading/grading";
import { FullAppOptions } from "./options";

export function createFullAppGrader(
  agent: Agent,
  fixtures: Fixture[],
  reportsDirectory: string,
  summaryId: string,
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for grading.");
  }
  const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
  const scores: Score[] = [];
  const summary = path.join(
    reportDirectory(agent, undefined, reportsDirectory),
    `scores-${summaryId}.csv`,
  );
  return {
    async onComplete(
      fixture: Fixture,
      runId: string | undefined,
      signal: AbortSignal,
    ): Promise<void> {
      const run = await claimReportRun(
        reportsDirectory,
        agent,
        fixture.name,
        runId,
        signal,
      );
      try {
        scores.push(
          await gradeFixture(fixture, agent, codex, {
            reportsDirectory: run.reportsDirectory,
            runId,
            signal,
          }),
        );
      } finally {
        await run.release();
      }
    },
    async save(): Promise<void> {
      if (scores.length === 0) return;
      await mkdir(path.dirname(summary), { recursive: true });
      await writeScores(
        summary,
        fixtures.flatMap((fixture) =>
          scores.filter((score) => score.fixture === fixture.name),
        ),
      );
      process.stdout.write(`${agent} summary written to ${summary}\n`);
    },
  };
}

export async function gradeFullAppEval(options: FullAppOptions): Promise<void> {
  const agent = AgentSchema.parse(options.agent);
  const fixtures = await selectComparisonFixtures(options.fixtures);
  const runs = await Promise.all(
    fixtures.map((fixture) =>
      findReportRun(
        options.outputDirectory,
        agent,
        fixture.name,
        options.runIds,
      ),
    ),
  );
  const unmatched = options.runIds.filter(
    (id) => !runs.some((run) => run.runId === id),
  );
  if (unmatched.length > 0) {
    throw new Error(
      `No ${agent} reports for --run-id ${unmatched.join(", ")} among the selected fixtures in ${reportDirectory(agent, undefined, options.outputDirectory)}.`,
    );
  }
  // Each regrade gets its own summary so other invocations' summaries are never rewritten.
  const grader = createFullAppGrader(
    agent,
    fixtures,
    options.outputDirectory,
    createRunId(),
  );
  const cleanup = setupSandboxCleanup();
  try {
    cleanup.signal.throwIfAborted();
    for (const [index, fixture] of fixtures.entries()) {
      await grader.onComplete(fixture, runs[index].runId, cleanup.signal);
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
