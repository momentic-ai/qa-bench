import { parseArgs } from "node:util";

import { Browser } from "../../evals/agent";
import {
  executionOptions,
  parseExecutionOptions,
} from "../../evals/execution-options";
import { parseRunIds } from "../../evals/report-files";
import { REPORTS_DIRECTORY } from "../../evals/scores";

export const DEFAULT_TIME_LIMIT_MS = 120 * 60_000;

export type FullAppOptions = {
  agent?: string;
  gradeOnly?: boolean;
  runIds: string[];
  fixtures?: string;
  concurrency?: number;
  maxConcurrentSubAgents?: number;
  timeLimitMs: number;
  /** Mo's time budget; omitted unless --time-limit or --minutes is passed. */
  moTimeBudgetMs?: number;
  outputDirectory: string;
  browser: Browser;
};

export function parseFullAppOptions(args: string[]): FullAppOptions {
  const { values } = parseArgs({
    args,
    options: {
      ...executionOptions,
      agent: { type: "string" },
      "max-concurrent-sub-agents": { type: "string" },
      fixtures: { type: "string" },
      "grade-only": { type: "boolean", default: false },
      "run-id": { type: "string", multiple: true },
      browser: { type: "string" },
    },
    strict: true,
  });
  const { concurrency, timeLimitMs, outputDirectory } =
    parseExecutionOptions(values);
  let maxConcurrentSubAgents: number | undefined;
  if (values["max-concurrent-sub-agents"] !== undefined) {
    maxConcurrentSubAgents = Number(values["max-concurrent-sub-agents"]);
    if (
      !Number.isSafeInteger(maxConcurrentSubAgents) ||
      maxConcurrentSubAgents < 1
    ) {
      throw new Error(
        "--max-concurrent-sub-agents must be a positive integer.",
      );
    }
    if (values.agent !== "mo") {
      throw new Error(
        "--max-concurrent-sub-agents is supported only with --agent mo; other agents have separate browser capacity limits.",
      );
    }
  }
  if (values["run-id"] && !values["grade-only"])
    throw new Error(
      "--run-id selects saved runs to regrade with --grade-only.",
    );
  return {
    agent: values.agent,
    browser: parseBrowser(values.agent, values.browser),
    fixtures: values.fixtures,
    concurrency,
    maxConcurrentSubAgents,
    timeLimitMs: timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
    moTimeBudgetMs: timeLimitMs,
    outputDirectory: outputDirectory ?? REPORTS_DIRECTORY,
    gradeOnly: values["grade-only"],
    runIds: parseRunIds(values["run-id"]),
  };
}

function parseBrowser(
  agent: string | undefined,
  browser: string | undefined,
): Browser {
  if (browser === undefined) return "browserbase";
  if (agent !== "codex" && agent !== "claude")
    throw new Error("--browser applies only to --agent codex or claude.");
  if (browser !== "browserbase" && browser !== "local")
    throw new Error("--browser must be browserbase or local.");
  return browser;
}
