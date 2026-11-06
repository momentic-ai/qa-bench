import { createHash } from "node:crypto";
import { z } from "zod";

import { Finding, KnownBug, SeveritySchema } from "../evals/reports";
import { Assessment } from "./assessment";

export const GRADING_THREAD_OPTIONS = {
  model: "gpt-6.1-sol",
  modelReasoningEffort: "high",
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  webSearchMode: "disabled",
} as const;
const INDEX = z.number().int().nonnegative();
export const JudgeOutputSchema = z
  .object({
    // One entry per finding, in the same order as the findings input.
    findings: z.array(
      z
        .object({
          set: z.enum(["groundTruth", "knownInvalid", "unverified"]),
          index: INDEX.nullable().describe(
            "Zero-based index of the matched entry in set, or null when unverified.",
          ),
          reproStepsIndex: INDEX.nullable().describe(
            "For a groundTruth match, the zero-based index of the matching reproSteps case; otherwise null.",
          ),
          reason: z.string().min(1),
          clarity: z
            .number()
            .int()
            .min(1)
            .max(5)
            .describe(
              "How clearly the finding shows its failure, from 1 (vague) to 5 (clear and well evidenced).",
            ),
          severity: SeveritySchema,
          severityReason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export const GRADING_OUTPUT_SCHEMA = z.toJSONSchema(JudgeOutputSchema, {
  target: "openai-3.0",
});

// One entry per finding, so a finding can never land in two sets.
export function toAssessment(
  output: z.infer<typeof JudgeOutputSchema>,
  findingCount: number,
  groundTruth: KnownBug[],
  knownInvalidCount: number,
): Omit<Assessment, "duplicates"> {
  if (output.findings.length !== findingCount) {
    throw new Error(
      `Judge returned ${output.findings.length} entries for ${findingCount} findings.`,
    );
  }
  const assessment: Omit<Assessment, "duplicates"> = {
    matches: [],
    invalidMatches: [],
    unverified: [],
    severities: [],
  };
  for (const [findingIndex, item] of output.findings.entries()) {
    const { index, reason } = item;
    const setSize = {
      groundTruth: groundTruth.length,
      knownInvalid: knownInvalidCount,
      unverified: 0,
    }[item.set];
    if (
      (item.set === "unverified") !== (index === null) ||
      (index !== null && index >= setSize) ||
      (item.set !== "groundTruth" && item.reproStepsIndex !== null)
    ) {
      throw new Error(
        `Judge chose a missing entry for finding ${findingIndex}.`,
      );
    }
    if (item.set === "groundTruth") {
      const cases = groundTruth[index!].reproSteps.length;
      if (item.reproStepsIndex !== null && item.reproStepsIndex >= cases) {
        throw new Error(
          `Judge chose a missing reproSteps case for finding ${findingIndex}.`,
        );
      }
      assessment.matches.push({
        groundTruthIndex: index!,
        reproStepsIndex: item.reproStepsIndex,
        findingIndex,
        reason,
      });
    } else if (item.set === "knownInvalid") {
      assessment.invalidMatches.push({
        knownInvalidIndex: index!,
        findingIndex,
        reason,
      });
    } else {
      assessment.unverified.push({ findingIndex, reason });
    }
    assessment.severities.push({
      findingIndex,
      severity: item.severity,
      reason: item.severityReason,
    });
  }
  // Dedupe keeps the first of repeated matches, so put the clearest findings first.
  const clarity = (item: { findingIndex: number }) =>
    -output.findings[item.findingIndex].clarity;
  assessment.matches.sort((a, b) => clarity(a) - clarity(b));
  assessment.invalidMatches.sort((a, b) => clarity(a) - clarity(b));
  return assessment;
}
// TODO: give the judge each finding's network and console evidence, so it can spot environment failures like a sandbox HTTPS redirect.
const JudgeFindingSchema = z.object({
  name: z.string(),
  summary: z.string(),
  expected: z.string(),
  actual: z.string(),
  reproSteps: z.array(z.string()),
});
const JudgeGroundTruthSchema = JudgeFindingSchema.extend({
  reproSteps: z.array(z.array(z.string())),
});
const JudgeKnownInvalidSchema = JudgeFindingSchema.extend({
  reason: z.string(),
});
export const GRADING_PROMPT_TEMPLATE = `Grade QA findings for the {{fixture}} app area. The JSON below has:
- groundTruth: human-reviewed bugs in this area.
- knownInvalid: human-reviewed claims that were rejected, each with its reason.
- findings: claims that an agent reported as bugs while searching for bugs in the {{fixture}} app area.

Matching:
1. Go through each finding one at a time and match it to a groundTruth bug or a knownInvalid entry.
   - Match on summary, expected, and actual: they must describe the same bug as the entry's summary, expected, and actual. Use reproSteps only as context. It's not required that reproSteps match exactly.
   - Being on the same page, control, or element does not make two bugs the same. They are the same bug when the same failing behavior was observed, even if the finding got there through a different page or flow.
2. For each groundTruth match, compare the finding's reproSteps with each of the bug's reproSteps cases. Pick the case that reaches the bug the same way. Ignore insignificant differences in wording, test data, or extra setup steps. Set reproStepsIndex to that case's index, or null if the finding reaches the bug some other way.
3. Each finding matches at most one groundTruth bug or knownInvalid entry. Several findings can match the same one.
4. Every other finding is unverified.

Return exactly one entry per finding, in the same order as findings, with a short reason. Rate how clearly each finding shows its failure; when several findings repeat one match, the clearest is kept.

Estimate a severity for every finding from its described impact:
- 1: UI, accessibility, copy, typo, presentation, or minor usability defect without described functional misbehavior.
- 3: functional misbehavior, such as a button not working, an incorrect result, or the wrong state displayed during submission, even temporarily.
- 5: a broken or unusable page, or an unlabeled user-visible raw error dump.
Pick the lowest severity that fits when unsure, and explain it briefly.

{{data}}`;

export function gradingPrompt(
  fixture: string,
  groundTruth: KnownBug[],
  knownInvalid: Finding[],
  findings: Finding[],
) {
  const data = {
    groundTruth: groundTruth.map((bug, index) => ({
      index,
      ...JudgeGroundTruthSchema.parse(bug),
    })),
    knownInvalid: knownInvalid.map((claim, index) => ({
      index,
      ...JudgeKnownInvalidSchema.parse(claim),
    })),
    findings: findings.map((finding, index) => ({
      index,
      ...JudgeFindingSchema.parse(finding),
    })),
  };
  return GRADING_PROMPT_TEMPLATE.replace(
    /\{\{fixture\}\}|\{\{data\}\}/g,
    (placeholder) =>
      placeholder === "{{fixture}}" ? fixture : JSON.stringify(data),
  );
}

export const GRADING_METHOD_SHA256 = createHash("sha256")
  .update(
    JSON.stringify({
      promptTemplate: GRADING_PROMPT_TEMPLATE,
      outputSchema: GRADING_OUTPUT_SCHEMA,
      threadOptions: GRADING_THREAD_OPTIONS,
      inputSchemas: [
        JudgeFindingSchema,
        JudgeGroundTruthSchema,
        JudgeKnownInvalidSchema,
      ].map((schema) => z.toJSONSchema(schema)),
    }),
  )
  .digest("hex");
