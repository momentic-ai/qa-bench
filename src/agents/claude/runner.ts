import { BenchmarkAgent } from "../../evals/types";
import { codexRunner } from "../codex/runner";

export const claudeRunner: BenchmarkAgent = {
  ...codexRunner,
  name: "Claude",
  reportDirectory: "claude",
};

export const claudeLocalRunner: BenchmarkAgent = {
  ...codexRunner,
  name: "Claude (local browser)",
  reportDirectory: "claude-local",
};
