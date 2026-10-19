import { runCommand } from "./command";

export function runMoCommand(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number },
) {
  return runCommand(process.env.MO_EVAL_CLI ?? "qa", args, options);
}

export async function validateMoCli() {
  const version = await runMoCommand(["--version"], { timeoutMs: 10_000 });
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 24)) {
    // 0.21.1 rejects the --time-budget start option; 0.24.0 accepts it.
    throw new Error(
      `Mo evals require QA CLI >=0.24.0; found ${version}. Run qa upgrade, or set MO_EVAL_CLI to a supported executable.`,
    );
  }
}
