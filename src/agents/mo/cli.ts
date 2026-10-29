import { runCommand } from "../../evals/command";

const MO_CLI_VERSION = "0.30.0";

export function runMoCommand(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number },
) {
  return runCommand(process.env.MO_EVAL_CLI ?? "qa", args, options);
}

export async function validateMoCli() {
  const version = await runMoCommand(["--version"], { timeoutMs: 10_000 });
  if (version !== MO_CLI_VERSION) {
    throw new Error(
      `Mo evals require QA CLI ${MO_CLI_VERSION}; found ${version}. Set MO_EVAL_CLI to a ${MO_CLI_VERSION} executable.`,
    );
  }
  const startHelp = await runMoCommand(["start", "--help"], {
    timeoutMs: 10_000,
  });
  if (!startHelp.includes("--no-test-cases")) {
    throw new Error(
      `QA CLI ${version} does not support --no-test-cases. Set MO_EVAL_CLI to a ${MO_CLI_VERSION} executable with test case opt-out support.`,
    );
  }
}

export async function getMoCost(
  sessionId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const stdout = await runMoCommand(["cost", sessionId], {
    signal,
  });
  return JSON.parse(stdout);
}
