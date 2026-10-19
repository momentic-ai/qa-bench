import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  loadComparison,
  loadInputComparison,
  renderComparison,
} from "./evals/comparison";
import { resolveOutputDirectory } from "./evals/execution-options";
import { selectComparisonFixtures } from "./evals/fixture-selection";
import { findReportRun, parseRunIds } from "./evals/report-files";
import { AGENTS, Agent, REPORTS_DIRECTORY } from "./evals/scores";
import { Fixture } from "./evals/types";

const { values } = parseArgs({
  options: {
    fixtures: { type: "string" },
    input: { type: "string", multiple: true },
    output: { type: "string" },
    "output-dir": { type: "string" },
    "run-id": { type: "string", multiple: true },
  },
  strict: true,
});
const reportsDirectory =
  resolveOutputDirectory(values["output-dir"]) ?? REPORTS_DIRECTORY;
if (values.input && (values.fixtures || values["run-id"])) {
  throw new Error(
    "Use --input for agent CSVs or --fixtures and --run-id to select saved fixture scores.",
  );
}
const runIds = parseRunIds(values["run-id"]);
let comparison;
if (values.input) {
  // Explicit CSV inputs preserve the saved grades without relying on the current fixture checkout.
  comparison = await loadInputComparison(values.input);
} else {
  // Keep fixture selection compatible with existing local eval report directories.
  const fixtures = await selectComparisonFixtures(values.fixtures);
  const agents: Agent[] = [];
  for (const agent of AGENTS) {
    const missing: Fixture[] = [];
    for (const fixture of fixtures) {
      const run = await findReportRun(
        reportsDirectory,
        agent,
        fixture.name,
        runIds,
      );
      if (!existsSync(path.join(run.directory, "scores.csv")))
        missing.push(fixture);
    }
    if (missing.length === 0) {
      agents.push(agent);
    } else if (missing.length < fixtures.length) {
      // Partial coverage would total this agent over a different fixture set.
      throw new Error(
        `${agent} scores are missing for ${missing.map((fixture) => fixture.name).join(", ")}; run it for every selected fixture or merge with --input.`,
      );
    }
  }
  if (!agents.length)
    throw new Error("No saved scores for the selected fixtures.");
  comparison = await loadComparison(fixtures, reportsDirectory, agents, runIds);
}
const { scores, totals, reviewFiles } = comparison;
const output = path.resolve(
  values.output ?? path.join(reportsDirectory, "comparison.md"),
);
if (!/\.md$/i.test(output)) throw new Error("--output must end in .md.");
const markdown = renderComparison(
  scores,
  totals,
  path.dirname(output),
  reviewFiles,
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, markdown);
process.stdout.write(markdown);
