import csvParser from "csv-parser";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";

export const AgentSchema = z.enum(["mo", "codex", "claude"]);
export type Agent = z.infer<typeof AgentSchema>;
export const AGENTS = AgentSchema.options;
const count = z.number().int().nonnegative();

// Spec §7: precision is TRUE / (TRUE + FALSE); duplicates and unresolved findings are reported separately.
export function metrics(
  knownHits: number,
  knownInvalid: number,
  groundTruth: number,
) {
  const adjudicated = knownHits + knownInvalid;
  return {
    precision: adjudicated === 0 ? null : knownHits / adjudicated,
    recall: groundTruth === 0 ? 0 : knownHits / groundTruth,
  };
}

export function throughput(
  submissions: number,
  knownHits: number,
  durationSeconds: number,
) {
  return {
    findings_per_minute: (submissions * 60) / durationSeconds,
    correct_findings_per_minute: (knownHits * 60) / durationSeconds,
  };
}

export function costPerVerifiedBug(score: {
  cost_usd: number | null;
  cost_complete: boolean;
  known_hits: number;
}) {
  if (!score.cost_complete || score.cost_usd === null) return null;
  if (score.known_hits > 0) return score.cost_usd / score.known_hits;
  return null;
}

export const ScoreSchema = z
  .object({
    fixture: z.string().min(1),
    agent: AgentSchema,
    ground_truth_sha256: z.string(),
    known_invalid_sha256: z.string(),
    judge: z.literal("gpt-6.1-sol/high"),
    grading_method_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    ground_truth: count,
    bugs: count,
    flags: count,
    known_hits: count,
    unverified: count,
    ignored: count.default(0),
    outside_area_known_hits: count.default(0),
    outside_area_known_invalid: count.default(0),
    outside_area_duplicates: count.default(0),
    outside_area_precision: z.number().min(0).max(1).nullable().default(null),
    outside_area_ground_truth_sha256: z.string().default(""),
    outside_area_known_invalid_sha256: z.string().default(""),
    duplicates: count,
    known_invalid: count,
    known_misses: count,
    precision: z.number().min(0).max(1).nullable(),
    recall: z.number().min(0).max(1),
    findings_per_minute: z.number().nonnegative(),
    correct_findings_per_minute: z.number().nonnegative(),
    severity_1: count,
    severity_3: count,
    severity_5: count,
    severity_sum: count,
    score: z.number().int(),
    duration_seconds: z.number().positive(),
    cost_usd: z.number().nonnegative().nullable(),
    cost_complete: z.boolean(),
    partial: z.boolean(),
    review_path: z.string(),
  })
  .strict()
  .refine((score) => {
    const rates = metrics(
      score.known_hits,
      score.known_invalid,
      score.ground_truth,
    );
    const ratesPerMinute = throughput(
      score.bugs,
      score.known_hits,
      score.duration_seconds,
    );
    const outsidePrecision = metrics(
      score.outside_area_known_hits,
      score.outside_area_known_invalid,
      0,
    ).precision;
    if (score.cost_complete && score.cost_usd === null) return false;
    const submissions =
      score.known_hits +
      score.unverified +
      score.ignored +
      score.duplicates +
      score.known_invalid +
      score.outside_area_known_hits +
      score.outside_area_known_invalid +
      score.outside_area_duplicates;
    if (submissions !== score.bugs) return false;
    if (score.flags > score.bugs) return false;
    if (score.known_hits > score.ground_truth) return false;
    if (score.known_misses !== score.known_invalid) return false;
    const severityCount =
      score.severity_1 + score.severity_3 + score.severity_5;
    if (severityCount !== score.known_hits) return false;
    const severitySum =
      score.severity_1 + 3 * score.severity_3 + 5 * score.severity_5;
    if (score.severity_sum !== severitySum) return false;
    const expectedScore =
      score.severity_sum - score.known_misses - score.duplicates;
    if (score.score !== expectedScore) return false;
    const findingsRateDifference = Math.abs(
      score.findings_per_minute - ratesPerMinute.findings_per_minute,
    );
    if (findingsRateDifference >= 1e-10) return false;
    const correctRateDifference = Math.abs(
      score.correct_findings_per_minute -
        ratesPerMinute.correct_findings_per_minute,
    );
    if (correctRateDifference >= 1e-10) return false;
    if (score.precision === null || rates.precision === null) {
      if (score.precision !== rates.precision) return false;
    } else if (Math.abs(score.precision - rates.precision) >= 1e-10) {
      return false;
    }
    if (Math.abs(score.recall - rates.recall) >= 1e-10) return false;
    if (score.outside_area_precision === null || outsidePrecision === null) {
      return score.outside_area_precision === outsidePrecision;
    }
    return Math.abs(score.outside_area_precision - outsidePrecision) < 1e-10;
  }, "Inconsistent counts or metrics in saved scores");
export type Score = z.infer<typeof ScoreSchema>;
const COLUMNS = ScoreSchema.keyof().options;
const HEADER = COLUMNS.join(",");

export const REPORTS_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../reports",
);

export function reportDirectory(
  agent: Agent,
  fixture?: string,
  reportsDirectory = REPORTS_DIRECTORY,
) {
  return path.join(reportsDirectory, agent, fixture ?? "");
}

export function scoresCsv(scores: Score[]) {
  const parsed = scores.map((score) => ScoreSchema.parse(score));
  const columns = COLUMNS;
  return (
    [
      columns.join(","),
      ...parsed.map((score) =>
        columns
          .map((column) => {
            const value = score[column];
            const cell = value === null ? "" : String(value);
            if (/[",\r\n]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`;
            return cell;
          })
          .join(","),
      ),
    ].join("\n") + "\n"
  );
}

export async function writeScores(file: string, scores: Score[]) {
  await writeFile(file, scoresCsv(scores));
}

export async function readScores(file: string) {
  const source = await readFile(file, "utf8");
  const header = source.split(/\r?\n/, 1)[0];
  if (header !== HEADER) {
    // Older scores lack the current reference-based severity and disposition metrics.
    throw new Error(
      `Outdated score format in ${file}; regrade the saved report with the current eval harness before comparing.`,
    );
  }
  const parser = Readable.from([source]).pipe(csvParser({ strict: true }));
  const scores: Score[] = [];
  for await (const row of parser) {
    const cells = z.record(z.string(), z.string()).parse(row);
    const numeric = Object.fromEntries(
      Object.entries(cells).map(([key, value]) => {
        if (key === "grading_method_sha256") return [key, value || null];
        if (
          [
            "fixture",
            "agent",
            "ground_truth_sha256",
            "known_invalid_sha256",
            "judge",
            "review_path",
            "outside_area_ground_truth_sha256",
            "outside_area_known_invalid_sha256",
          ].includes(key)
        ) {
          // Identity, review paths, and grading metadata remain strings in CSV.
          return [key, value];
        }
        if (key === "partial" || key === "cost_complete") {
          // Parse booleans explicitly; the string "false" is truthy in JS.
          return [key, z.enum(["true", "false"]).parse(value) === "true"];
        }
        if (
          ["cost_usd", "precision", "outside_area_precision"].includes(key) &&
          value === ""
        ) {
          // Unknown costs and undefined precision must not silently become zero.
          return [key, null];
        }
        if (!value.trim()) {
          // Required counts cannot be inferred from missing CSV measurements.
          throw new Error(`Missing ${key} in ${file}`);
        }
        return [key, Number(value)];
      }),
    );
    const parsed = ScoreSchema.safeParse(numeric);
    if (!parsed.success) {
      // Mixed grader versions or inconsistent counts require a fresh grade.
      throw new Error(
        `Invalid saved scores in ${file}; regrade the saved report with the current eval harness. ${parsed.error.message}`,
      );
    }
    scores.push(parsed.data);
  }
  return scores;
}

export function totalScores(scores: Score[], agent: Agent): Score {
  if (scores.length === 0) {
    // Empty selections cannot produce a meaningful total or duration.
    throw new Error(`No saved scores for ${agent}`);
  }
  const total = scores.reduce(
    (sum, score) => ({
      ...sum,
      ground_truth: sum.ground_truth + score.ground_truth,
      bugs: sum.bugs + score.bugs,
      flags: sum.flags + score.flags,
      known_hits: sum.known_hits + score.known_hits,
      unverified: sum.unverified + score.unverified,
      ignored: sum.ignored + score.ignored,
      outside_area_known_hits:
        sum.outside_area_known_hits + score.outside_area_known_hits,
      outside_area_known_invalid:
        sum.outside_area_known_invalid + score.outside_area_known_invalid,
      outside_area_duplicates:
        sum.outside_area_duplicates + score.outside_area_duplicates,
      duplicates: sum.duplicates + score.duplicates,
      known_invalid: sum.known_invalid + score.known_invalid,
      known_misses: sum.known_misses + score.known_misses,
      severity_1: sum.severity_1 + score.severity_1,
      severity_3: sum.severity_3 + score.severity_3,
      severity_5: sum.severity_5 + score.severity_5,
      severity_sum: sum.severity_sum + score.severity_sum,
      duration_seconds: sum.duration_seconds + score.duration_seconds,
      cost_usd: (sum.cost_usd ?? 0) + (score.cost_usd ?? 0),
      cost_complete: sum.cost_complete && score.cost_complete,
      partial: sum.partial || score.partial,
      grading_method_sha256:
        sum.grading_method_sha256 === score.grading_method_sha256
          ? sum.grading_method_sha256
          : null,
    }),
    {
      ...scores[0],
      ground_truth: 0,
      bugs: 0,
      flags: 0,
      known_hits: 0,
      unverified: 0,
      ignored: 0,
      outside_area_known_hits: 0,
      outside_area_known_invalid: 0,
      outside_area_duplicates: 0,
      duplicates: 0,
      known_invalid: 0,
      known_misses: 0,
      severity_1: 0,
      severity_3: 0,
      severity_5: 0,
      severity_sum: 0,
      score: 0,
      duration_seconds: 0,
      cost_usd: 0,
      cost_complete: true,
      partial: false,
    },
  );
  let costUsd: number | null = null;
  if (scores.some((score) => score.cost_usd !== null)) {
    costUsd = total.cost_usd;
  }
  return ScoreSchema.parse({
    ...total,
    fixture: "Total",
    score: total.severity_sum - total.known_misses - total.duplicates,
    agent,
    ground_truth_sha256: "",
    known_invalid_sha256: "",
    outside_area_ground_truth_sha256: "",
    outside_area_known_invalid_sha256: "",
    outside_area_precision: metrics(
      total.outside_area_known_hits,
      total.outside_area_known_invalid,
      0,
    ).precision,
    review_path: "",
    cost_usd: costUsd,
    ...throughput(total.bugs, total.known_hits, total.duration_seconds),
    ...metrics(total.known_hits, total.known_invalid, total.ground_truth),
  });
}
