import { Codex } from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { claudeRunner } from "../agents/claude/runner";
import { codexRunner } from "../agents/codex/runner";
import { devinQaRunner } from "../agents/devin/qa-reader";
import { moRunner } from "../agents/mo/runner";
import { readGroundTruth } from "../evals/ground-truth";
import { verifyCaseMetadata } from "../evals/report-files";
import { DurationSchema, Finding, loadGroundTruth } from "../evals/reports";
import {
  OutsideAreaReview,
  writeReviewArtifacts,
} from "../evals/review-artifacts";
import {
  Agent,
  ScoreSchema,
  metrics,
  reportDirectory,
  throughput,
  writeScores,
} from "../evals/scores";
import { BenchmarkAgent, Fixture } from "../evals/types";
import { partitionAreaAssessment } from "./area-assessment";
import {
  Assessment,
  loadKnownInvalid,
  scoreAssessment,
  validateAssessment,
} from "./assessment";
import {
  GRADING_APP_SCHEMA,
  GRADING_METHOD_SHA256,
  GRADING_OUTPUT_SCHEMA,
  GRADING_PROMPT_TEMPLATE,
  GRADING_THREAD_OPTIONS,
  gradingPrompt,
} from "./grading-contract";

const root = path.resolve(import.meta.dirname, "../..");
const RUNNERS: Record<Agent, BenchmarkAgent> = {
  mo: moRunner,
  "devin-qa": devinQaRunner,
  "codex-playwright-mcp": codexRunner,
  "claude-playwright-mcp": claudeRunner,
  "codex-agent-browser": {
    ...codexRunner,
    name: "codex-agent-browser",
    reportDirectory: "codex-agent-browser",
  },
  "claude-agent-browser": {
    ...claudeRunner,
    name: "claude-agent-browser",
    reportDirectory: "claude-agent-browser",
  },
};

export async function gradeFixture(
  fixture: Fixture,
  agent: Agent,
  codex: Codex,
  options: {
    reportsDirectory?: string;
    runId?: string;
    runner?: BenchmarkAgent;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  const runner = options.runner ?? RUNNERS[agent];
  let directory: string;
  if (options.reportsDirectory) {
    directory = path.join(
      options.reportsDirectory,
      runner.reportDirectory,
      fixture.name,
    );
  } else {
    directory = reportDirectory(agent, fixture.name);
  }
  if (options.runId) directory = path.join(directory, options.runId);
  // A failed regrade must not leave an older score looking current.
  await rm(path.join(directory, "scores.csv"), { force: true });
  await verifyCaseMetadata(directory, fixture);
  const { text: groundTruthFile, bugs: groundTruth } =
    await readGroundTruth(fixture);
  const knownInvalid = await loadKnownInvalid(
    path.dirname(fixture.groundTruthFile),
  );
  const report = await runner.getReport(directory);
  const flags = report.flags ?? [];
  const bugs = [...report.bugs, ...flags];
  const duration = DurationSchema.extend({
    partial: z.boolean().optional(),
  }).parse(
    JSON.parse(await readFile(path.join(directory, "duration.json"), "utf8")),
  );
  if ((duration.errors?.length ?? 0) > 0) {
    // Harness failures cannot become apparently valid benchmark scores.
    throw new Error(
      `Invalid report duration in ${directory}: execution errors were recorded.`,
    );
  }
  let judged = await judge(
    fixture,
    groundTruth,
    knownInvalid.bugs,
    bugs,
    codex,
    options.signal,
  );
  let outsideKnownHits = 0;
  let outsideKnownInvalid = 0;
  let outsideDuplicates = 0;
  let unverified = judged.unverified.length;
  let outsideGroundTruthHash = "";
  let outsideKnownInvalidHash = "";
  let outsideArea: OutsideAreaReview | undefined;
  if (fixture.fullAppGroundTruthFile) {
    const fullGroundTruth = await loadGroundTruth(
      fixture.fullAppGroundTruthFile,
    );
    const fullKnownInvalid = await loadKnownInvalid(
      path.dirname(fixture.fullAppGroundTruthFile),
    );
    outsideGroundTruthHash = createHash("sha256")
      .update(fullGroundTruth.text)
      .digest("hex");
    outsideKnownInvalidHash = fullKnownInvalid.hash;
    const acceptedNames = new Set(groundTruth.map((bug) => bug.name));
    const rejectedNames = new Set(knownInvalid.bugs.map((bug) => bug.name));
    const remainingGroundTruth = fullGroundTruth.bugs.filter(
      (bug) => !acceptedNames.has(bug.name),
    );
    const remainingKnownInvalid = fullKnownInvalid.bugs.filter(
      (bug) => !rejectedNames.has(bug.name),
    );
    const findingIndices = judged.unverified.map(
      (finding) => finding.findingIndex,
    );
    const remaining = await judge(
      fixture,
      remainingGroundTruth,
      remainingKnownInvalid,
      findingIndices.map((index) => bugs[index]),
      codex,
      options.signal,
    );
    const partition = partitionAreaAssessment(
      judged,
      remaining,
      findingIndices,
    );
    judged = partition.assessment;
    outsideKnownHits = partition.outsideKnownHits;
    outsideKnownInvalid = partition.outsideKnownInvalid;
    outsideDuplicates = partition.outsideDuplicates.length;
    unverified = partition.unverified;
    outsideArea = {
      knownHits: remaining.matches.map((match) => ({
        findingIndex: findingIndices[match.findingIndex],
        reference: remainingGroundTruth[match.groundTruthIndex],
        reason: match.reason,
      })),
      knownInvalid: remaining.invalidMatches.map((match) => ({
        findingIndex: findingIndices[match.findingIndex],
        reference: remainingKnownInvalid[match.knownInvalidIndex],
        reason: match.reason,
      })),
      duplicates: partition.outsideDuplicates,
    };
    await writeFile(
      path.join(directory, "outside-area-grading.json"),
      JSON.stringify(
        {
          groundTruth: remainingGroundTruth,
          knownInvalid: remainingKnownInvalid,
          findingIndices,
          assessment: remaining,
          outsideDuplicates: partition.outsideDuplicates,
          groundTruthHash: outsideGroundTruthHash,
          knownInvalidHash: outsideKnownInvalidHash,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    await rm(path.join(directory, "outside-area-grading.json"), {
      force: true,
    });
  }
  const {
    assessment,
    knownHits: matchedBugs,
    scores,
  } = scoreAssessment(
    judged,
    groundTruth,
    knownInvalid.bugs.length,
    bugs.length,
  );
  const knownHits = assessment.matches.length;
  const knownInvalidCount = assessment.invalidMatches.length;
  const duplicates = assessment.duplicates.length;
  await writeFile(
    path.join(directory, "grading.json"),
    JSON.stringify(
      {
        judge: "gpt-6.1-sol/high",
        grading_method_sha256: GRADING_METHOD_SHA256,
        gradingPromptTemplate: GRADING_PROMPT_TEMPLATE,
        groundTruth,
        knownHits: matchedBugs,
        bugs,
        flags,
        assessment,
        knownInvalid: knownInvalid.bugs,
        outsideArea,
      },
      null,
      2,
    ) + "\n",
  );
  const reviewPath = await writeReviewArtifacts({
    reportDirectory: directory,
    report: { ...report, bugs },
    assessment,
    groundTruth,
    knownInvalid: knownInvalid.bugs,
    outsideArea,
  });
  const score = ScoreSchema.parse({
    fixture: fixture.name,
    agent,
    ground_truth_sha256: createHash("sha256")
      .update(groundTruthFile)
      .digest("hex"),
    known_invalid_sha256: knownInvalid.hash,
    judge: "gpt-6.1-sol/high",
    grading_method_sha256: GRADING_METHOD_SHA256,
    ground_truth: groundTruth.length,
    bugs: bugs.length,
    flags: flags.length,
    ...scores,
    unverified,
    ignored: assessment.ignored?.length ?? 0,
    outside_area_known_hits: outsideKnownHits,
    outside_area_known_invalid: outsideKnownInvalid,
    outside_area_duplicates: outsideDuplicates,
    outside_area_precision: metrics(outsideKnownHits, outsideKnownInvalid, 0)
      .precision,
    outside_area_ground_truth_sha256: outsideGroundTruthHash,
    outside_area_known_invalid_sha256: outsideKnownInvalidHash,
    duplicates,
    known_invalid: knownInvalidCount,
    ...metrics(
      knownHits,
      knownInvalidCount,
      groundTruth.length,
      scores.duplicate_known_hits,
      scores.duplicate_known_invalid,
    ),
    ...throughput(bugs.length, knownHits, report.durationSeconds),
    review_path: options.runId
      ? path.posix.join(options.runId, reviewPath)
      : reviewPath,
    duration_seconds: report.durationSeconds,
    cost_usd: report.costUsd,
    cost_complete: report.costComplete,
    partial: duration.partial ?? false,
    time_limit_ms: duration.timeLimitMs ?? null,
  });
  await writeScores(path.join(directory, "scores.csv"), [score]);
  process.stdout.write(
    `${fixture.name}: ${agent} scores written to ${directory}/scores.csv\n`,
  );
  return score;
}
export async function judge(
  fixture: Fixture,
  groundTruth: Finding[],
  knownInvalid: Finding[],
  bugs: Finding[],
  codex: Codex,
  signal?: AbortSignal,
): Promise<Assessment> {
  signal?.throwIfAborted();
  if (bugs.length === 0) {
    // An empty report needs no model inference and has no classified claims.
    return {
      matches: [],
      invalidMatches: [],
      duplicates: [],
      unverified: [],
      severities: [],
    };
  }
  const thread = codex.startThread({
    ...GRADING_THREAD_OPTIONS,
    workingDirectory: root,
  });
  const prompt = gradingPrompt(fixture.name, groundTruth, knownInvalid, bugs);
  const { finalResponse } = await thread.run(prompt, {
    signal,
    outputSchema: GRADING_OUTPUT_SCHEMA,
  });
  const assessment = GRADING_APP_SCHEMA.parse(JSON.parse(finalResponse));
  return validateAssessment(assessment, {
    groundTruth: groundTruth.length,
    knownInvalid: knownInvalid.length,
    findings: bugs.length,
  });
}
