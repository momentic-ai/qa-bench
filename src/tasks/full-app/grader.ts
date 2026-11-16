import { Codex } from "@openai/codex-sdk";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { claimReportRun } from "../../evals/report-files";
import { Agent, Score, reportDirectory, writeScores } from "../../evals/scores";
import { Fixture } from "../../fixtures/types";
import { gradeFixture } from "../../grading/grade-fixture";
import { GradingPromptRunner, createGradingProxy } from "../../grading/proxy";

export class FullAppGrader {
  private readonly codex: Codex;
  private readonly runPrompt: GradingPromptRunner | undefined;
  private readonly scores: Score[] = [];
  private readonly summary: string;

  constructor(
    private readonly agent: Agent,
    private readonly fixtures: Fixture[],
    private readonly reportsDirectory: string,
    summaryId: string,
  ) {
    this.runPrompt = createGradingProxy();
    if (!this.runPrompt && !process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for grading.");
    }
    this.codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
    this.summary = path.join(
      reportDirectory(agent, undefined, reportsDirectory),
      `scores-${summaryId}.csv`,
    );
  }

  async grade(
    fixture: Fixture,
    runId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const run = await claimReportRun(
      this.reportsDirectory,
      this.agent,
      fixture.name,
      runId,
      signal,
    );
    try {
      const score = await gradeFixture(fixture, this.agent, this.codex, {
        reportsDirectory: run.reportsDirectory,
        runId,
        signal,
        runPrompt: this.runPrompt,
      });
      this.scores.push(score);
    } finally {
      await run.release();
    }
  }

  async save(): Promise<void> {
    if (this.scores.length === 0) return;
    await mkdir(path.dirname(this.summary), { recursive: true });
    await writeScores(
      this.summary,
      this.fixtures.flatMap((fixture) =>
        this.scores.filter((score) => score.fixture === fixture.name),
      ),
    );
    process.stdout.write(`${this.agent} summary written to ${this.summary}\n`);
  }
}
