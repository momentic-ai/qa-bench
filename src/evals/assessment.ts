import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { readDataset } from "./dataset";
import { FindingSchema, KnownBug, SeveritySchema } from "./reports";

const INDEX = z.number().int().nonnegative();
const REASON = z.string().min(1);

export const KnownInvalidFindingSchema = FindingSchema.extend({
  reason: REASON,
});
export type KnownInvalidFinding = z.infer<typeof KnownInvalidFindingSchema>;

export const KnownInvalidSchema = z
  .object({
    bugs: z.array(KnownInvalidFindingSchema),
  })
  .strict();

export async function loadKnownInvalid(fixtureDirectory: string) {
  let contents: string;
  try {
    contents = await readDataset(
      path.join(fixtureDirectory, "known-invalid.json"),
    );
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      // Malformed or unreadable references must fail instead of silently changing grades.
      throw err;
    }
    contents = '{"bugs":[]}\n';
  }
  const { bugs } = KnownInvalidSchema.parse(JSON.parse(contents));
  return { bugs, hash: createHash("sha256").update(contents).digest("hex") };
}

export const AssessmentSchema = z
  .object({
    matches: z.array(
      z
        .object({
          groundTruthIndex: INDEX,
          findingIndex: INDEX,
          reason: REASON,
        })
        .strict(),
    ),
    invalidMatches: z.array(
      z
        .object({
          knownInvalidIndex: INDEX,
          findingIndex: INDEX,
          reason: REASON,
        })
        .strict(),
    ),
    duplicates: z.array(
      z
        .object({
          findingIndex: INDEX,
          canonicalFindingIndex: INDEX,
          reason: REASON,
        })
        .strict(),
    ),
    unverified: z.array(
      z.object({ findingIndex: INDEX, reason: REASON }).strict(),
    ),
    ignored: z
      .array(z.object({ findingIndex: INDEX, reason: REASON }).strict())
      .optional(),
    severities: z.array(
      z
        .object({
          findingIndex: INDEX,
          severity: SeveritySchema,
          reason: REASON,
        })
        .strict(),
    ),
  })
  .strict();

export type Assessment = z.infer<typeof AssessmentSchema>;

export function scoreAssessment(
  assessment: Assessment,
  groundTruth: KnownBug[],
  knownInvalidCount: number,
  findingsCount: number,
) {
  validateAssessment(assessment, {
    groundTruth: groundTruth.length,
    knownInvalid: knownInvalidCount,
    findings: findingsCount,
  });
  const knownHits = assessment.matches.map((match) => ({
    ...groundTruth[match.groundTruthIndex],
    ...match,
  }));
  const severitySum = knownHits.reduce((sum, hit) => sum + hit.severity, 0);
  // Known misses are submitted claims matching reviewed negatives; unfound positives affect recall only.
  const knownMisses = assessment.invalidMatches.length;
  return {
    knownHits,
    assessment: {
      ...assessment,
      severities: assessment.severities.map((estimate) => {
        let canonicalFindingIndex = estimate.findingIndex;
        if (assessment.ignored !== undefined) {
          const duplicate = assessment.duplicates.find(
            (item) => item.findingIndex === estimate.findingIndex,
          );
          canonicalFindingIndex =
            duplicate?.canonicalFindingIndex ?? canonicalFindingIndex;
        }
        const hit = knownHits.find(
          (item) => item.findingIndex === canonicalFindingIndex,
        );
        if (hit) {
          // A matched claim inherits its fixed reference weight, never the judge's estimate.
          return {
            findingIndex: estimate.findingIndex,
            severity: hit.severity,
            reason:
              "Stored ground-truth severity; independent of the judge's impact estimate.",
          };
        }
        return estimate;
      }),
    },
    scores: {
      known_hits: knownHits.length,
      known_misses: knownMisses,
      severity_1: knownHits.filter((hit) => hit.severity === 1).length,
      severity_3: knownHits.filter((hit) => hit.severity === 3).length,
      severity_5: knownHits.filter((hit) => hit.severity === 5).length,
      severity_sum: severitySum,
      score: severitySum - knownMisses - assessment.duplicates.length,
    },
  };
}

export function validateAssessment(
  assessment: Assessment,
  counts: { groundTruth: number; knownInvalid: number; findings: number },
): Assessment {
  const classified = new Set<number>();
  function classify(index: number) {
    if (index >= counts.findings || classified.has(index)) {
      // An overlapping or nonexistent finding would corrupt the score partition.
      throw new Error(
        `Invalid or multiply classified finding index: ${index}.`,
      );
    }
    classified.add(index);
  }
  const matchedReferences = new Set<number>();
  for (const match of assessment.matches) {
    if (
      match.groundTruthIndex >= counts.groundTruth ||
      matchedReferences.has(match.groundTruthIndex)
    ) {
      // Each reviewed positive can earn at most one known hit.
      throw new Error(
        `Invalid or repeated ground-truth index: ${match.groundTruthIndex}.`,
      );
    }
    matchedReferences.add(match.groundTruthIndex);
    classify(match.findingIndex);
  }
  const invalidReferences = new Set<number>();
  for (const match of assessment.invalidMatches) {
    if (
      match.knownInvalidIndex >= counts.knownInvalid ||
      invalidReferences.has(match.knownInvalidIndex)
    ) {
      // Repeated claims about one reviewed negative must be grouped as duplicates.
      throw new Error(
        `Invalid or repeated known-invalid index: ${match.knownInvalidIndex}.`,
      );
    }
    invalidReferences.add(match.knownInvalidIndex);
    classify(match.findingIndex);
  }
  for (const finding of assessment.unverified) {
    classify(finding.findingIndex);
  }
  const canonicalIndices = new Set(classified);
  const ignoredIndices = new Set<number>();
  for (const finding of assessment.ignored ?? []) {
    classify(finding.findingIndex);
    ignoredIndices.add(finding.findingIndex);
  }
  for (const duplicate of assessment.duplicates) {
    if (!canonicalIndices.has(duplicate.canonicalFindingIndex)) {
      // Duplicate chains and self-references cannot identify a single canonical claim.
      throw new Error(
        `Duplicate does not reference a canonical finding: ${duplicate.findingIndex}.`,
      );
    }
    classify(duplicate.findingIndex);
  }
  if (classified.size !== counts.findings) {
    // Missing classifications must fail rather than silently becoming unverified.
    throw new Error("Missing finding classifications in judge assessment.");
  }
  const severityIndices = new Set<number>();
  for (const item of assessment.severities) {
    if (
      item.findingIndex >= counts.findings ||
      severityIndices.has(item.findingIndex) ||
      ignoredIndices.has(item.findingIndex)
    ) {
      throw new Error(
        `Invalid or repeated severity index: ${item.findingIndex}.`,
      );
    }
    severityIndices.add(item.findingIndex);
  }
  if (severityIndices.size !== counts.findings - ignoredIndices.size) {
    // An incomplete severity list would leave gaps in the human review queue.
    throw new Error("Missing finding severities in judge assessment.");
  }
  return assessment;
}
