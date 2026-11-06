import { markdownTable } from "markdown-table";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadKnownInvalid } from "../grading/assessment";
import { readGroundTruth } from "./ground-truth";
import { findReportRun, runLabel, verifyCaseMetadata } from "./report-files";
import { loadGroundTruth } from "./reports";
import {
  AGENTS,
  Agent,
  REPORTS_DIRECTORY,
  Score,
  costPerVerifiedBug,
  readScores,
  reportDirectory,
  totalScores,
} from "./scores";
import { Fixture } from "./types";

const SUITE_NAME = "OSS bug bash";

/** A saved score plus its run's label, which separates runs with different settings. */
export type LabeledScore = Score & { label: string };

type ScoreGroup = {
  agent: Agent;
  label: string;
  scores: LabeledScore[];
};

export function groupScoresByRun(scores: LabeledScore[]) {
  const groups = new Map<string, ScoreGroup>();
  for (const score of scores) {
    let group = groups.get(score.label);
    if (!group) {
      // Create groups only for observed scores so no empty runs are exported.
      group = { agent: score.agent, label: score.label, scores: [] };
      groups.set(score.label, group);
    }
    group.scores.push(score);
  }
  return [...groups.values()].sort(
    (a, b) =>
      AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent) ||
      a.label.localeCompare(b.label),
  );
}

type ComparisonTotal = LabeledScore & {
  fixtureCount: number;
};

export async function loadComparison(
  fixtures: Fixture[],
  reportsDirectory: string,
  agents: readonly Agent[] = AGENTS,
  runIds: readonly string[] = [],
) {
  const scores: LabeledScore[] = [];
  const reviewFiles = new Map<string, string>();
  const selectedRuns = new Set<string>();
  const agentLabels = new Map<Agent, string>();
  for (const fixture of fixtures) {
    const { text: groundTruth, bugs } = await readGroundTruth(fixture);
    const hash = createHash("sha256").update(groundTruth).digest("hex");
    const referenceDirectory = path.dirname(fixture.groundTruthFile);
    const knownInvalid = await loadKnownInvalid(referenceDirectory);
    let outsideGroundTruthHash = "";
    let outsideKnownInvalidHash = "";
    if (fixture.fullAppGroundTruthFile) {
      const outsideGroundTruth = await loadGroundTruth(
        fixture.fullAppGroundTruthFile,
      );
      outsideGroundTruthHash = createHash("sha256")
        .update(outsideGroundTruth.text)
        .digest("hex");
      const outsideKnownInvalid = await loadKnownInvalid(
        path.dirname(fixture.fullAppGroundTruthFile),
      );
      outsideKnownInvalidHash = outsideKnownInvalid.hash;
    }
    for (const agent of agents) {
      const run = await findReportRun(
        reportsDirectory,
        agent,
        fixture.name,
        runIds,
      );
      if (run.runId) selectedRuns.add(run.runId);
      const file = path.join(run.directory, "scores.csv");
      const rows = await readScores(file);
      await verifyCaseMetadata(path.dirname(file), fixture);
      const score = rows[0];
      if (
        rows.length !== 1 ||
        !score ||
        score.agent !== agent ||
        score.fixture !== fixture.name
      ) {
        // A fixture score file must describe exactly the selected agent and app.
        throw new Error(
          `Wrong or missing fixture/agent scores in ${file}; run eval for this agent and fixture.`,
        );
      }
      if (
        score.ground_truth_sha256 !== hash ||
        score.ground_truth !== bugs.length
      ) {
        // Prevent comparison across changed ground truth or outdated grading inputs.
        throw new Error(
          `Ground truth changed for ${fixture.name}; regrade the saved report for ${agent}.`,
        );
      }
      if (score.known_invalid_sha256 !== knownInvalid.hash) {
        // Accepted invalid findings are grading inputs shared by every agent.
        throw new Error(
          `Known invalid findings changed for ${fixture.name}; regrade the saved report for ${agent}.`,
        );
      }
      if (
        score.outside_area_ground_truth_sha256 !== outsideGroundTruthHash ||
        score.outside_area_known_invalid_sha256 !== outsideKnownInvalidHash
      ) {
        throw new Error(
          `Outside-area references changed for ${fixture.name}; regrade the saved report for ${agent}.`,
        );
      }
      const label = await runLabel(agent, run.directory);
      const previousLabel = agentLabels.get(agent);
      if (previousLabel !== undefined && previousLabel !== label) {
        // Latest runs per fixture can use different settings; totals must not mix them.
        throw new Error(
          `${agent} runs for the selected fixtures use different settings (${previousLabel}; ${label}). Select runs with --run-id or merge with --input.`,
        );
      }
      agentLabels.set(agent, label);
      const labeled = { ...score, label };
      scores.push(labeled);
      reviewFiles.set(
        reviewKey(labeled),
        path.join(run.directory, path.posix.basename(score.review_path)),
      );
    }
  }
  const unmatched = runIds.filter((id) => !selectedRuns.has(id));
  if (unmatched.length > 0) {
    throw new Error(
      `No saved scores for --run-id ${unmatched.join(", ")} among the selected agents and fixtures in ${reportsDirectory}.`,
    );
  }
  return { ...buildComparison(scores), reviewFiles };
}

export async function loadInputComparison(files: string[]) {
  const scores: LabeledScore[] = [];
  const reviewFiles = new Map<string, string>();
  for (const file of files) {
    const directory = path.dirname(path.resolve(file));
    for (const score of await readScores(file)) {
      // Summaries sit above fixture folders, fixture scores beside review.md, and archived runs under archive/.
      const candidates = [
        path.join(directory, score.fixture, score.review_path),
        path.join(directory, path.posix.basename(score.review_path)),
        path.join(
          path.dirname(directory),
          "archive",
          path.basename(directory),
          score.fixture,
          score.review_path,
        ),
      ];
      // Settings come from the run folder, which exists even if its review file was removed.
      const runDirectory = candidates
        .map((candidate) => path.dirname(candidate))
        .find((candidate) => existsSync(path.join(candidate, "duration.json")));
      const labeled = {
        ...score,
        label: runDirectory
          ? await runLabel(score.agent, runDirectory)
          : score.agent,
      };
      scores.push(labeled);
      reviewFiles.set(
        reviewKey(labeled),
        candidates.find((candidate) => existsSync(candidate)) ?? candidates[0],
      );
    }
  }
  return { ...buildComparison(scores), reviewFiles };
}

function reviewKey(score: LabeledScore) {
  return JSON.stringify([score.label, score.fixture]);
}

export function buildComparison(scores: LabeledScore[]) {
  if (scores.length === 0) {
    // Empty inputs cannot produce totals or dashboard runs.
    throw new Error("No fixture scores to merge or upload.");
  }
  const identities = new Set<string>();
  const references = new Map<string, Score>();
  for (const score of scores) {
    const identity = JSON.stringify([score.label, score.fixture]);
    if (identities.has(identity)) {
      // Repeated inputs must not double-count a session in aggregate metrics.
      throw new Error(`Duplicate scores for ${score.label}/${score.fixture}.`);
    }
    identities.add(identity);
    if (!score.ground_truth_sha256 || !score.known_invalid_sha256) {
      // Aggregate rows have no unique reference provenance and cannot be merged again.
      throw new Error("Use per-fixture scores, not totals.");
    }
    const previous = references.get(score.fixture);
    if (previous) {
      if (
        previous.ground_truth_sha256 !== score.ground_truth_sha256 ||
        previous.ground_truth !== score.ground_truth
      ) {
        // Explicit CSV inputs need the same reference checks as fixture-based loading.
        throw new Error(
          `Ground truth differs between agents for ${score.fixture}.`,
        );
      }
      if (previous.known_invalid_sha256 !== score.known_invalid_sha256) {
        // Reference review changes affect the denominator even when positive references match.
        throw new Error(
          `Known invalid findings differ between agents for ${score.fixture}.`,
        );
      }
      if (previous.time_limit_ms !== score.time_limit_ms) {
        // A comparison cannot mix recorded budgets with unknown or different budgets.
        throw new Error(
          `Mismatched time limits for ${score.fixture}; rerun all agents with the same --time-limit.`,
        );
      }
      if (
        previous.outside_area_ground_truth_sha256 !==
          score.outside_area_ground_truth_sha256 ||
        previous.outside_area_known_invalid_sha256 !==
          score.outside_area_known_invalid_sha256
      ) {
        throw new Error(
          `Outside-area references differ between agents for ${score.fixture}.`,
        );
      }
    }
    references.set(score.fixture, score);
  }
  const groups = groupScoresByRun(scores);
  const methods = new Set<string>();
  for (const group of groups) {
    const method = group.scores[0].grading_method_sha256;
    if (
      !method ||
      group.scores.some((score) => score.grading_method_sha256 !== method)
    )
      throw new Error(
        `Unknown or different grading methods for ${group.scores[0].fixture}; regrade copied reports with the same eval harness before comparing agents.`,
      );
    methods.add(method);
  }
  if (methods.size > 1)
    throw new Error(
      "Different grading methods; regrade copied reports with the same eval harness before comparing agents.",
    );
  const totals: ComparisonTotal[] = groups.map(
    ({ agent, label, scores: groupScores }) => ({
      ...totalScores(
        groupScores.map(({ label: _, ...score }) => score),
        agent,
      ),
      label,
      fixture: `Total (${SUITE_NAME})`,
      fixtureCount: groupScores.length,
    }),
  );
  return { scores, totals };
}

function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function cost(value: number | null) {
  return value === null ? "Unavailable" : `$${value.toFixed(2)}`;
}

function table(rows: (string | number)[][]) {
  return markdownTable(
    rows.map((row) =>
      row.map((cell) =>
        String(cell).replaceAll("|", "\\|").replaceAll("\n", " "),
      ),
    ),
  );
}

function reviewLink(
  score: LabeledScore,
  outputDirectory: string,
  reviewFiles: ReadonlyMap<string, string>,
) {
  if (!score.review_path) {
    // Totals have separate review files per fixture rather than a synthetic queue.
    return "—";
  }
  const target = path
    .relative(
      outputDirectory,
      reviewFiles.get(reviewKey(score)) ??
        path.join(
          reportDirectory(score.agent, score.fixture),
          score.review_path,
        ),
    )
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/");
  return `[${score.unverified} to review](${target})`;
}

export function renderComparison(
  scores: LabeledScore[],
  totals: ComparisonTotal[],
  outputDirectory = REPORTS_DIRECTORY,
  reviewFiles: ReadonlyMap<string, string> = new Map(),
) {
  const rows = [...scores, ...totals];
  return [
    "# Bug bash comparison",
    "",
    "Saved GPT-6.1 Sol/high grades against the same known-bug and accepted invalid-finding sets. Flags count as bug submissions. Unmatched findings remain unverified until further verification; they are not automatically invalid or accepted as new bugs.",
    "",
    table([
      [
        "Fixture",
        "Agent",
        "Recall",
        "Precision",
        "Known hits",
        "Extra known hits",
        "Severity sum",
        "Score",
        "Known misses",
        "Unverified",
        "Duplicates",
        "Known invalid",
        "Outside area hits / rejected / duplicates",
        "Outside area precision",
        "Further verification",
        "Submissions / min",
        "Known hits / min",
      ],
      ...rows.map((score) => [
        score.fixture,
        score.label,
        percent(score.recall),
        percent(score.precision),
        score.known_hits,
        score.extra_known_hits,
        score.severity_sum,
        score.score,
        score.known_misses,
        score.unverified,
        score.duplicates,
        score.known_invalid,
        `${score.outside_area_known_hits} / ${score.outside_area_known_invalid} / ${score.outside_area_duplicates}`,
        percent(score.outside_area_precision),
        reviewLink(score, outputDirectory, reviewFiles),
        score.findings_per_minute.toFixed(3),
        score.correct_findings_per_minute.toFixed(3),
      ]),
    ]),
    "",
    "Known hits count each reference bug once; extra known hits are further findings of an already-found bug. Precision = (known hits + extra known hits + their duplicates) / (those + known invalid + their duplicates); unverified findings are excluded. Recall = known hits / reference bug count. Severity sum adds the stored reference severity of each unique known hit. Score = severity sum - (known misses + duplicates). Known misses count submissions matching the accepted negative dataset (also shown as known invalid). Unfound positive references affect recall only. Unverified submissions are excluded. Duplicates are surplus repeat matches of the same reference bug and reproSteps case, or of the same known-invalid entry; findings of one bug through different cases count as extra known hits instead. Totals use summed counts, not an average of fixture percentages. N/A means no submissions have a scored disposition. Throughput includes flags and uses summed counts divided by summed agent-run duration; correct_findings_per_minute counts known hits.",
    "",
    "## Severity and performance",
    "",
    "Severity 1: UI issues, accessibility, or typos. Severity 3: functional misbehavior. Severity 5: broken pages or unexplained user-visible error dumps. Severity counts and points use fixed reference severities for unique known hits only. Unverified, invalid, and duplicate submissions earn no severity points.",
    "",
    table([
      [
        "Fixture",
        "Agent",
        "Submissions",
        "Flags included",
        "Known hits at severity 1 / 3 / 5",
        "Duration (s)",
        "Measured cost (USD)",
        "Cost / verified bug",
        "Cost complete",
        "Partial",
        "Time limit (s)",
        "Grading method",
      ],
      ...rows.map((score) => {
        let timeLimit: string | number = "Unknown/mixed";
        if (score.time_limit_ms !== null) {
          timeLimit = score.time_limit_ms / 1000;
        }
        return [
          score.fixture,
          score.label,
          score.bugs,
          score.flags,
          `${score.severity_1} / ${score.severity_3} / ${score.severity_5}`,
          score.duration_seconds.toFixed(1),
          cost(score.cost_usd),
          cost(costPerVerifiedBug(score)),
          String(score.cost_complete),
          String(score.partial),
          timeLimit,
          score.grading_method_sha256 ?? "Unknown/mixed",
        ];
      }),
    ]),
    "",
    "## Efficiency",
    "",
    table([
      [
        "Agent",
        "Cost / verified bug",
        "Cost / session",
        "Submissions / session",
        "Cost / submission",
        "Submissions / hour",
        "Submissions / dollar",
        "Cost complete",
      ],
      ...totals.map((score) => {
        const sessions = score.fixtureCount;
        let costPerSession = "Unavailable";
        if (score.cost_complete && score.cost_usd !== null) {
          costPerSession = cost(score.cost_usd / sessions);
        }
        let costPerSubmission = "Unavailable";
        if (score.cost_complete) {
          if (score.bugs === 0) {
            costPerSubmission = "—";
          } else if (score.cost_usd !== null) {
            costPerSubmission = cost(score.cost_usd / score.bugs);
          }
        }
        let submissionsPerDollar = "Unavailable";
        if (score.cost_complete && score.cost_usd !== null) {
          if (score.cost_usd === 0) {
            submissionsPerDollar = "—";
          } else {
            submissionsPerDollar = (score.bugs / score.cost_usd).toFixed(3);
          }
        }
        return [
          score.label,
          cost(costPerVerifiedBug(score)),
          costPerSession,
          (score.bugs / sessions).toFixed(1),
          costPerSubmission,
          (score.bugs / (score.duration_seconds / 3600)).toFixed(2),
          submissionsPerDollar,
          String(score.cost_complete),
        ];
      }),
    ]),
    "",
    "Review links contain reproduction instructions, available evidence links, and grading reasons. Costs exclude browser/E2B charges; Mo session spend and Codex/Claude model costs are directional comparisons. Incomplete costs are measured subtotals; totals preserve available subtotals and are complete only when every fixture is complete. Cost / verified bug divides complete spend by unique known hits and is unavailable with zero known hits or incomplete billing. Submission efficiency includes unverified, invalid, and duplicate reports. Cost efficiency is unavailable for incomplete billing. Missing costs stay unavailable. Durations exclude app provisioning and grading; partial means at least one run was partial. Detailed dispositions and severity reasons remain in each fixture's grading.json.",
    "",
  ].join("\n");
}
