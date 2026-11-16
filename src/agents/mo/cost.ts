import { runMoCommand } from "./cli";

export async function getMoCost(
  sessionId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const stdout = await runMoCommand(["cost", sessionId], {
    signal,
  });
  return JSON.parse(stdout);
}
