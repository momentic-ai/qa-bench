import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { readDataset } from "../evals/dataset";
import { FindingSchema, KnownBug } from "../evals/reports";

export const KnownInvalidFindingSchema = FindingSchema.extend({
  reason: z.string().min(1),
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

type Reason = { findingIndex: number; reason: string };
export type Assessment = {
  // reproStepsIndex is null when the finding reaches the bug through none of its reproSteps cases.
  matches: (Reason & {
    groundTruthIndex: number;
    reproStepsIndex: number | null;
  })[];
  invalidMatches: (Reason & { knownInvalidIndex: number })[];
  duplicates: (Reason & { canonicalFindingIndex: number })[];
  unverified: Reason[];
  severities: (Reason & { severity: KnownBug["severity"] })[];
};

export function scoreAssessment(
  assessment: Assessment,
  groundTruth: KnownBug[],
) {
  const matches = assessment.matches.map((match) => ({
    ...groundTruth[match.groundTruthIndex],
    ...match,
  }));
  // Recall credits each bug once, however many findings report it.
  const knownHits = matches.filter(
    (hit, i) =>
      matches.findIndex(
        (other) => other.groundTruthIndex === hit.groundTruthIndex,
      ) === i,
  );
  const severitySum = knownHits.reduce((sum, hit) => sum + hit.severity, 0);
  // Known misses are submitted claims matching reviewed negatives; unfound positives affect recall only.
  const knownMisses = assessment.invalidMatches.length;
  const matchedFindings = new Set(
    assessment.matches.map((match) => match.findingIndex),
  );
  const rejectedFindings = new Set(
    assessment.invalidMatches.map((match) => match.findingIndex),
  );
  return {
    knownHits,
    assessment: {
      ...assessment,
      severities: assessment.severities.map((estimate) => {
        const hit = matches.find(
          (item) => item.findingIndex === estimate.findingIndex,
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
      extra_known_hits: matches.length - knownHits.length,
      known_misses: knownMisses,
      duplicate_known_hits: assessment.duplicates.filter((duplicate) =>
        matchedFindings.has(duplicate.canonicalFindingIndex),
      ).length,
      duplicate_known_invalid: assessment.duplicates.filter((duplicate) =>
        rejectedFindings.has(duplicate.canonicalFindingIndex),
      ).length,
      severity_1: knownHits.filter((hit) => hit.severity === 1).length,
      severity_3: knownHits.filter((hit) => hit.severity === 3).length,
      severity_5: knownHits.filter((hit) => hit.severity === 5).length,
      severity_sum: severitySum,
      score: severitySum - knownMisses - assessment.duplicates.length,
    },
  };
}

// Repeat matches of one bug's reproSteps case, or of one rejected claim, become duplicates of the first.
export function dedupeAssessment(
  assessment: Omit<Assessment, "duplicates">,
): Assessment {
  const first = new Map<string, number>();
  const duplicates: Assessment["duplicates"] = [];
  function isRepeat(key: string | null, findingIndex: number, reason: string) {
    if (key === null) return false;
    const canonicalFindingIndex = first.get(key);
    if (canonicalFindingIndex === undefined) {
      first.set(key, findingIndex);
      return false;
    }
    duplicates.push({ findingIndex, canonicalFindingIndex, reason });
    return true;
  }
  return {
    ...assessment,
    matches: assessment.matches.filter(
      (match) =>
        !isRepeat(
          match.reproStepsIndex === null
            ? null
            : `bug ${match.groundTruthIndex} case ${match.reproStepsIndex}`,
          match.findingIndex,
          match.reason,
        ),
    ),
    invalidMatches: assessment.invalidMatches.filter(
      (match) =>
        !isRepeat(
          `invalid ${match.knownInvalidIndex}`,
          match.findingIndex,
          match.reason,
        ),
    ),
    duplicates,
  };
}
