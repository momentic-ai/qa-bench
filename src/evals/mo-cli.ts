import { runCommand } from "./command";

const MO_CLI_VERSION = "0.34.0";

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
}
