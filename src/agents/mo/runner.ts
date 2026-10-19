import { readFile } from "node:fs/promises";
import path from "node:path";

import { readOptionalCost, readReportDuration } from "../../evals/report-files";
import {
  MoCostSchema,
  MoFindingsSchema,
  MoReportSchema,
} from "../../evals/reports";
import { BenchmarkAgent } from "../../evals/types";

export const moRunner: BenchmarkAgent = {
  name: "Mo",
  reportDirectory: "mo",
  async getReport(directory) {
    const report = MoReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
    );
    const findings = MoFindingsSchema.parse(
      JSON.parse(
        await readFile(path.join(directory, report.findings.bugs), "utf8"),
      ),
    );
    const cost = await readOptionalCost(directory);
    const costUsd =
      cost === null
        ? null
        : MoCostSchema.parse(cost)
            .totals.filter((total) => total.currency === "mo_spend")
            .reduce((sum, total) => sum + total.amount, 0);
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
      // Invalid cost data must not produce misleading efficiency metrics.
      throw new Error(`Invalid Mo report cost in ${directory}.`);
    }
    const bugs = findings.filter((finding) => finding.kind === "bug");
    return {
      bugs,
      flags: findings.filter((finding) => finding.kind === "flag"),
      costUsd,
      costComplete: false,
      durationSeconds: await readReportDuration(directory),
    };
  },
};
