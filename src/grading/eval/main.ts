import { Codex } from "@openai/codex-sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { selectComparisonFixtures } from "../../evals/fixture-selection";
import { readGroundTruth } from "../../evals/ground-truth";
import { FindingSchema, KnownBug } from "../../evals/reports";
import { Fixture } from "../../evals/types";
import { KnownInvalidFinding, loadKnownInvalid } from "../assessment";
import { judge } from "../grading";

// Several references are accepted when labels duplicate one bug.
const ReferenceSchema = z.union([z.string(), z.array(z.string()).min(2)]);
const CasesSchema = z
  .object({
    cases: z.array(
      z
        .object({
          fixture: z.string(),
          finding: FindingSchema.strict(),
          expected: z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("match"),
                reference: ReferenceSchema,
                reproStepsIndex: z
                  .number()
                  .int()
                  .nonnegative()
                  .nullable()
                  .optional(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("invalid"),
                reference: ReferenceSchema,
              })
              .strict(),
            z.object({ kind: z.literal("unverified") }).strict(),
          ]),
        })
        .strict(),
    ),
  })
  .strict();

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required for the grader eval.");
}
const { cases } = CasesSchema.parse(
  JSON.parse(
    await readFile(path.join(import.meta.dirname, "cases.json"), "utf8"),
  ),
);
const fixtures = new Map(
  (
    await selectComparisonFixtures(
      [...new Set(cases.map((item) => item.fixture))].join(","),
    )
  ).map((fixture) => [fixture.name, fixture]),
);
const labels = new Map<
  string,
  Promise<{ groundTruth: KnownBug[]; knownInvalid: KnownInvalidFinding[] }>
>();
// Each area's labels load once, on first use, so a bad file fails only its own cases.
function loadLabels(name: string, fixture: Fixture) {
  if (!labels.has(name)) {
    labels.set(
      name,
      Promise.all([
        readGroundTruth(fixture),
        loadKnownInvalid(path.dirname(fixture.groundTruthFile)),
      ]).then(([groundTruth, knownInvalid]) => ({
        groundTruth: groundTruth.bugs,
        knownInvalid: knownInvalid.bugs,
      })),
    );
  }
  return labels.get(name)!;
}
const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
// Each case is judged alone, so code-side duplicate removal never hides an answer.
async function runCase({
  fixture: name,
  finding,
  expected,
}: (typeof cases)[number]) {
  const fixture = fixtures.get(name)!;
  const { groundTruth, knownInvalid } = await loadLabels(name, fixture);
  const assessment = await judge(
    fixture,
    groundTruth,
    knownInvalid,
    [finding],
    codex,
  );
  const [match] = assessment.matches;
  const [invalid] = assessment.invalidMatches;
  let actual: {
    kind: string;
    reference?: string;
    reproStepsIndex?: number | null;
  } = {
    kind: "unverified",
  };
  if (match) {
    actual = {
      kind: "match",
      reference: groundTruth[match.groundTruthIndex].name,
      reproStepsIndex: match.reproStepsIndex,
    };
  } else if (invalid) {
    actual = {
      kind: "invalid",
      reference: knownInvalid[invalid.knownInvalidIndex].name,
    };
  }
  const references: (string | undefined)[] =
    "reference" in expected ? [expected.reference].flat() : [undefined];
  const pass =
    actual.kind === expected.kind &&
    references.includes(actual.reference) &&
    (!("reproStepsIndex" in expected) ||
      expected.reproStepsIndex === undefined ||
      actual.reproStepsIndex === expected.reproStepsIndex);
  return { name: finding.name, pass, expected, actual };
}
const results: Awaited<ReturnType<typeof runCase>>[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < cases.length) {
      const item = cases[next++];
      // A judge answer that fails validation is a failed case, not a failed eval.
      results.push(
        await runCase(item).catch((err: unknown) => ({
          name: item.finding.name,
          pass: false,
          expected: item.expected,
          actual: { kind: `error: ${String(err)}` },
        })),
      );
    }
  }),
);
for (const result of results) {
  process.stdout.write(`${result.pass ? "PASS" : "FAIL"} ${result.name}\n`);
  if (!result.pass) {
    process.stdout.write(
      `  expected ${JSON.stringify(result.expected)}\n  actual   ${JSON.stringify(result.actual)}\n`,
    );
  }
}
const passed = results.filter((result) => result.pass).length;
process.stdout.write(
  `${passed}/${results.length} cases passed (${((100 * passed) / results.length).toFixed(1)}%)\n`,
);
