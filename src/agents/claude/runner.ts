import { BenchmarkAgent } from "../../evals/types";
import { codexRunner } from "../codex/runner";

export const claudeRunner: BenchmarkAgent = {
  ...codexRunner,
  name: "Claude",
  reportDirectory: "claude",
};
