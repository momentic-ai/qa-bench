import { parseArgs } from "node:util";

import {
  Browser,
  CLAUDE_MODELS,
  CODEX_MODELS,
  ClaudeModel,
  CodexModel,
  MO_EFFORTS,
  MoEffort,
} from "../../evals/agent";
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
  timeLimitMs?: number;
  effort?: MoEffort;
  codexModel?: CodexModel;
  claudeModel?: ClaudeModel;
  outputDirectory: string;
  browser: Browser;
  preventCheating?: boolean;
};

export function parseFullAppOptions(args: string[]): FullAppOptions {
  const { values } = parseArgs({
    args,
    options: {
      ...executionOptions,
      agent: { type: "string" },
      "max-concurrent-sub-agents": { type: "string" },
      effort: { type: "string" },
      model: { type: "string" },
      fixtures: { type: "string" },
      "grade-only": { type: "boolean", default: false },
      "run-id": { type: "string", multiple: true },
      browser: { type: "string" },
      "prevent-cheating": { type: "boolean", default: false },
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
  let effort: MoEffort | undefined;
  if (values.effort !== undefined) {
    if (!MO_EFFORTS.includes(values.effort as MoEffort))
      throw new Error(`--effort must be one of ${MO_EFFORTS.join(", ")}.`);
    if (values.agent !== "mo")
      throw new Error("--effort is supported only with --agent mo.");
    effort = values.effort as MoEffort;
  }
  let codexModel: CodexModel | undefined;
  let claudeModel: ClaudeModel | undefined;
  if (values.model !== undefined) {
    if (values.agent?.startsWith("codex-"))
      codexModel = parseModel(CODEX_MODELS, values.model);
    else if (values.agent?.startsWith("claude-"))
      claudeModel = parseModel(CLAUDE_MODELS, values.model);
    else throw new Error("--model applies only to Codex and Claude agents.");
  }
  if (values["prevent-cheating"]) {
    if (
      !values.agent?.startsWith("codex-") &&
      !values.agent?.startsWith("claude-")
    )
      throw new Error(
        "--prevent-cheating applies only to Codex and Claude agents.",
      );
    if (values["grade-only"])
      throw new Error(
        "--prevent-cheating applies to new runs, not --grade-only.",
      );
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
    timeLimitMs,
    effort,
    codexModel,
    claudeModel,
    ...(values["prevent-cheating"] ? { preventCheating: true } : {}),
    outputDirectory: outputDirectory ?? REPORTS_DIRECTORY,
    gradeOnly: values["grade-only"],
    runIds: parseRunIds(values["run-id"]),
  };
}

function parseModel<Model extends string>(
  models: readonly Model[],
  model: string,
) {
  const selected = models.find((candidate) => candidate === model);
  if (!selected)
    throw new Error(`--model must be one of ${models.join(", ")}.`);
  return selected;
}

function parseBrowser(
  agent: string | undefined,
  browser: string | undefined,
): Browser {
  if (browser === undefined) return "browserbase";
  if (
    ![
      "codex-playwright-mcp",
      "claude-playwright-mcp",
      "codex-agent-browser",
      "claude-agent-browser",
      "codex-e2e",
      "claude-e2e",
    ].includes(agent ?? "")
  )
    throw new Error("--browser applies only to Codex and Claude agents.");
  if (browser !== "browserbase" && browser !== "kernel" && browser !== "local")
    throw new Error("--browser must be browserbase, kernel or local.");
  return browser;
}
