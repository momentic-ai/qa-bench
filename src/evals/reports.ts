import { z } from "zod";

import { readDataset } from "./dataset";

// These standalone readers validate exported files without loading the Mo runtime.
export const FindingSchema = z
  .object({
    name: z.string(),
    summary: z.string(),
    expected: z.string(),
    actual: z.string(),
    reproSteps: z.array(z.string()),
  })
  .passthrough();
export type Finding = z.infer<typeof FindingSchema>;

export const SeveritySchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
]);
// Labels list reproduction cases; a single list is read as one case.
export const ReproCasesSchema = z
  .union([z.array(z.array(z.string())), z.array(z.string())])
  .transform((steps) =>
    steps.length > 0 && steps.every((step) => Array.isArray(step))
      ? (steps as string[][])
      : [steps as string[]],
  );
export const KnownBugSchema = FindingSchema.extend({
  reproSteps: ReproCasesSchema,
  severity: SeveritySchema,
  sourceCause: z.string().min(1).optional(),
});
export type KnownBug = z.infer<typeof KnownBugSchema>;

export const ReportSchema = z
  .object({
    bugs: z.array(FindingSchema.strict()),
    areasExplored: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

export const GroundTruthSchema = z
  .object({ bugs: z.array(KnownBugSchema) })
  .passthrough();

export async function loadGroundTruth(file: string) {
  const text = await readDataset(file);
  const parsed = GroundTruthSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    // Report every missing/invalid weight before refusing to load this fixture.
    const severities = parsed.error.issues.filter(
      (issue) => issue.path[0] === "bugs" && issue.path[2] === "severity",
    );
    for (const issue of severities) {
      process.stderr.write(
        `${file}: bugs[${String(issue.path[1])}].severity is missing or invalid; required severity: 1 | 3 | 5.\n`,
      );
    }
    throw new Error(
      `Cannot load ground truth ${file}: ${parsed.error.message}`,
    );
  }
  return { text, bugs: parsed.data.bugs };
}
export const MoFindingsSchema = z.array(
  FindingSchema.extend({ kind: z.enum(["bug", "flag"]) }),
);
export const MoReportSchema = z
  .object({ findings: z.object({ bugs: z.string() }).passthrough() })
  .passthrough();
export const DurationSchema = z
  .object({
    duration: z.number(),
    timeLimitMs: z.number().int().positive().optional(),
    partial: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
    valid: z.boolean().optional(),
  })
  .passthrough();
export const MoCostSchema = z
  .object({
    totals: z.array(
      z.object({ currency: z.string(), amount: z.number() }).passthrough(),
    ),
  })
  .passthrough();
export const CodexCostSchema = z
  .object({
    estimatedUsd: z.number().nonnegative().nullable(),
    costComplete: z.boolean().optional(),
  })
  .passthrough();
