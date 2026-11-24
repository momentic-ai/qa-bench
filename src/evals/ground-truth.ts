import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { Fixture } from "../fixtures/types";
import { readDataset } from "./dataset";
import { FindingSchema } from "./reports";

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
}).strict();
export type KnownBug = z.infer<typeof KnownBugSchema>;

export const KnownInvalidFindingSchema = FindingSchema.extend({
  reproSteps: ReproCasesSchema,
  reason: z.string().min(1),
}).strict();
export type KnownInvalidFinding = z.infer<typeof KnownInvalidFindingSchema>;

export const GroundTruthSchema = z
  .object({ bugs: z.array(KnownBugSchema) })
  .strict();

export const KnownInvalidSchema = z
  .object({ bugs: z.array(KnownInvalidFindingSchema) })
  .strict();

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

export function readGroundTruth(fixture: Fixture) {
  return loadGroundTruth(fixture.groundTruthFile);
}
