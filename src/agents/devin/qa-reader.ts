import { readFile } from "node:fs/promises";
import path from "node:path";

import { readReportDuration } from "../../evals/report-files";
import { ReportSchema } from "../../evals/reports";
import { BenchmarkAgent } from "../../evals/types";

export const devinQaRunner: BenchmarkAgent = {
  name: "Devin QA",
  reportDirectory: "devin-qa",
  async getReport(directory) {
    const report = ReportSchema.parse(
      JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
    );
    return {
      bugs: report.bugs,
      costUsd: null,
      costComplete: false,
      durationSeconds: await readReportDuration(directory),
    };
  },
};
