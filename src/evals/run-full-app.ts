import { mkdir } from "node:fs/promises";
import path from "node:path";

import { FixtureExecution } from "../fixtures/execution";
import { FullAppOptions } from "../tasks/full-app/options";
import { EvalAgentDefinition } from "./agent";
import { basicBugbashBrief } from "./basic-brief";
import { bugbashBrief } from "./bugbash-brief";
import { selectComparisonFixtures } from "./fixture-selection";
import { writeJson } from "./json-file";
import { archivePreviousReports, saveCaseMetadata } from "./report-files";
import { runAgent } from "./run-agent";
import { runWorkers } from "./run-workers";
import { BenchmarkSandbox, Fixture } from "./types";

const packageDirectory = path.resolve(import.meta.dirname, "../..");

export async function runFullAppFixtures({
  agent: definition,
  options,
  runId,
  onComplete,
  fixtures: selectedFixtures,
}: {
  agent: EvalAgentDefinition;
  options: FullAppOptions;
  runId: string;
  onComplete?: (fixture: Fixture, signal: AbortSignal) => Promise<void>;
  fixtures?: Fixture[];
}): Promise<void> {
  const fixtures =
    selectedFixtures ?? (await selectComparisonFixtures(options.fixtures));
  if (!process.env.E2B_API_KEY) {
    // Fail before allocating fixtures when provisioning cannot authenticate.
    throw new Error("E2B_API_KEY is required.");
  }
  await definition.validateEnvironment(options.timeLimitMs, fixtures);
  await using resources = new FixtureExecution();
  const results = new Array<PromiseSettledResult<string>>(fixtures.length);
  try {
    resources.signal.throwIfAborted();
    await archivePreviousReports(
      fixtures,
      options.outputDirectory,
      definition.reportSubdirectory,
      runId,
    );
    process.stdout.write(
      `Run ${runId}: reports go to ${path.join(options.outputDirectory, definition.reportSubdirectory, "<fixture>", runId)}\n`,
    );
    await runWorkers({
      items: fixtures,
      concurrency: options.concurrency ?? definition.concurrency,
      signal: resources.signal,
      async run(fixture, index) {
        try {
          const reportPath = await runFixture({
            agentName: options.agent,
            definition,
            fixture,
            reportsDirectory: options.outputDirectory,
            runId,
            timeLimitMs: options.timeLimitMs,
            moTimeBudgetMs: options.moTimeBudgetMs,
            maxConcurrentSubAgents: options.maxConcurrentSubAgents,
            resources,
          });
          if (!resources.signal.aborted) {
            await onComplete?.(fixture, resources.signal);
          }
          results[index] = { status: "fulfilled", value: reportPath };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
          process.stderr.write(`${fixture.name}: ${reason}\n`);
          process.exitCode ||= 1;
        }
      },
    });
  } catch (error) {
    if (
      !resources.signal.aborted ||
      (error !== resources.signal.reason &&
        !(error instanceof Error && error.name === "AbortError"))
    )
      throw error;
  }
  for (const [index, result] of results.entries()) {
    if (result?.status === "fulfilled") {
      // Failed and cancelled fixtures have already reported their error or signal.
      process.stdout.write(
        `${fixtures[index].name}: Report: ${result.value}\n`,
      );
    }
  }
}

async function runFixture({
  agentName,
  definition,
  fixture,
  reportsDirectory,
  runId,
  timeLimitMs,
  moTimeBudgetMs,
  maxConcurrentSubAgents,
  resources,
}: {
  agentName: string | undefined;
  definition: EvalAgentDefinition;
  fixture: Fixture;
  reportsDirectory: string;
  runId: string;
  timeLimitMs: number;
  moTimeBudgetMs: number | undefined;
  maxConcurrentSubAgents: number | undefined;
  resources: FixtureExecution;
}) {
  resources.signal.throwIfAborted();
  const reportDirectory = path.join(
    reportsDirectory,
    definition.reportSubdirectory,
    fixture.name,
    runId,
  );
  const runDirectory = path.join(
    packageDirectory,
    "runs",
    definition.reportSubdirectory,
    fixture.name,
    runId,
  );
  await mkdir(reportDirectory, { recursive: true });
  await saveCaseMetadata(reportDirectory, fixture);
  let sandbox: BenchmarkSandbox | undefined;
  try {
    resources.signal.throwIfAborted();
    const setup = await resources.provision(fixture, timeLimitMs);
    sandbox = setup.sandbox;
    const url = setup.url;
    resources.signal.throwIfAborted();
    const agent = await definition.create(
      {
        agentName,
        fixture,
        targetUrl: url,
        timeLimitMs,
        moTimeBudgetMs,
        maxConcurrentSubAgents,
        reportDirectory,
        runDirectory,
      },
      resources.signal,
    );
    const run = await runAgent({
      agent,
      message:
        agentName === "mo"
          ? bugbashBrief(url, timeLimitMs, fixture)
          : basicBugbashBrief(url, timeLimitMs, fixture),
      timeLimitMs,
      signal: resources.signal,
    });
    try {
      // Record fixture cleanup failures before publishing metadata that comparison trusts.
      if (sandbox) await resources.release(sandbox);
    } catch (err) {
      run.errors.push(err);
    }
    let stopReason = run.stopReason;
    if (run.errors.length > 0) {
      stopReason = "failed";
    }
    await writeJson(path.join(reportDirectory, "duration.json"), {
      ...definition.config,
      startedAt: run.startedAt,
      duration: run.duration,
      startupDuration: run.startupDuration,
      cleanupDuration: run.cleanupDuration,
      timeLimitMs: run.timeLimitMs,
      finalizationDuration: run.finalizationDuration,
      partial: run.partial || run.errors.length > 0,
      stopReason,
      sessionId: run.results?.sessionId,
      errors: run.errors.map(String),
    });
    if (run.errors.length > 0) {
      // Preserve partial artifacts while preventing failed runs from appearing successful.
      throw new AggregateError(
        run.errors,
        `${fixture.name} did not finish cleanly; saved results and errors are in ${reportDirectory}`,
      );
    }
    process.stdout.write(
      `${fixture.name}: ${run.results?.bugCount ?? 0} findings (${run.stopReason}, ${run.duration.toFixed(1)}s).\n`,
    );
    return path.join(reportDirectory, "report.json");
  } finally {
    if (sandbox) await resources.release(sandbox);
  }
}
