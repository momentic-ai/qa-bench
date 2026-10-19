import { readFile } from "node:fs/promises";
import path from "node:path";

import { readOptionalCost, readReportDuration } from "../../evals/report-files";
import { CodexCostSchema, ReportSchema } from "../../evals/reports";
import { BenchmarkAgent } from "../../evals/types";

export const codexRunner: BenchmarkAgent = {
  name: "Codex",
  reportDirectory: "codex",
  async getReport(directory) {
    const report = ReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
    );
    const cost = await readOptionalCost(directory);
    const parsedCost = cost === null ? null : CodexCostSchema.parse(cost);
    const costUsd = parsedCost?.estimatedUsd ?? null;
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
      // Invalid cost data must not produce misleading efficiency metrics.
      throw new Error(`Invalid Codex report cost in ${directory}.`);
    }
    return {
      bugs: report.bugs,
      costUsd,
      // Legacy token-only reports retain their subtotal but lack browser accounting.
      costComplete: costUsd !== null && parsedCost?.costComplete === true,
      durationSeconds: await readReportDuration(directory),
    };
  },
};
