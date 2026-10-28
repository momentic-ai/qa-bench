import { setTimeout as delay } from "node:timers/promises";

import { TIMEOUT_MS } from "../tasks/full-app/options";
import { AgentResults, EvalAgent } from "./agent";

export type AgentRun = {
  results: AgentResults | null;
  /** Start of the measured agent budget. */
  startedAt: string | null;
  duration: number;
  startupDuration: number;
  cleanupDuration: number;
  partial: boolean;
  stopReason: "completed" | "timeout" | "cancelled" | "failed";
  errors: unknown[];
};

export async function runAgent({
  agent,
  message,
  signal,
  startupTimeoutMs = 900_000,
}: {
  agent: EvalAgent;
  message: string;
  signal: AbortSignal;
  startupTimeoutMs?: number;
}): Promise<AgentRun> {
  const startupStartedAt = Date.now();
  let startedAt: number | undefined;
  let startupFinishedAt: number | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const budget = new AbortController();
  const execution = new AbortController();
  const startup = new AbortController();
  const runSignal = AbortSignal.any([
    signal,
    startup.signal,
    budget.signal,
    execution.signal,
  ]);
  const startupTimeout = setTimeout(
    () =>
      startup.abort(
        new Error("Agent startup exceeded its separate time limit."),
      ),
    startupTimeoutMs,
  );
  const errors: unknown[] = [];
  let completed = false;
  let onReady: () => number;
  const ready = new Promise<number>((resolve, reject) => {
    const aborted = () => reject(runSignal.reason);
    runSignal.addEventListener("abort", aborted, { once: true });
    if (runSignal.aborted) aborted();
    onReady = () => {
      runSignal.throwIfAborted();
      if (startedAt === undefined) {
        startedAt = Date.now();
        startupFinishedAt = startedAt;
        clearTimeout(startupTimeout);
        runSignal.removeEventListener("abort", aborted);
        timeout = setTimeout(() => budget.abort(), TIMEOUT_MS);
        resolve(startedAt + TIMEOUT_MS);
      }
      return startedAt + TIMEOUT_MS;
    };
  });
  const deadline = ready.then(async (deadlineMs) => {
    await delay(Math.max(0, deadlineMs - Date.now()), undefined, {
      signal: runSignal,
    });
    budget.abort();
  });
  const started = Promise.resolve().then(async () => {
    runSignal.throwIfAborted();
    const result = await agent.start(
      message,
      runSignal,
      agent.preparesEnvironment ? undefined : onReady(),
      onReady,
    );
    if (startedAt === undefined)
      throw new Error("Agent did not signal readiness before dispatch.");
    return result;
  });
  const completion = started.then((execution) => {
    if (execution) {
      // Existing adapters can finish early without adding a fifth lifecycle method.
      return execution.completion;
    }
    return deadline;
  });
  try {
    // Completion observers may only settle after termination; they cannot gate the cutoff.
    await Promise.race([completion, deadline]);
    runSignal.throwIfAborted();
    completed = true;
  } catch (err) {
    if (startup.signal.aborted) {
      errors.push(startup.signal.reason);
    } else if (!runSignal.aborted) {
      errors.push(err);
    }
  } finally {
    startupFinishedAt ??= Date.now();
    clearTimeout(startupTimeout);
    clearTimeout(timeout);
    execution.abort();
  }

  const stoppedAt = Date.now();
  let stopReason: AgentRun["stopReason"] = "failed";
  if (signal.aborted) {
    // A user interruption is separate from reaching the configured budget.
    stopReason = "cancelled";
  } else if (budget.signal.aborted) {
    // Budget exhaustion is a comparable partial result, not a provider failure.
    stopReason = "timeout";
  } else if (completed) {
    stopReason = "completed";
  }

  try {
    await agent.terminate();
  } catch (err) {
    errors.push(err);
  }
  // Let execution observers settle after termination.
  await Promise.allSettled([completion, deadline]);
  const finishedAt = Date.now();
  let results: AgentResults | null = null;
  const collection = new AbortController();
  let cancellationTimeout: NodeJS.Timeout | undefined;
  const cancelCollection = () => {
    cancellationTimeout ??= setTimeout(
      () => collection.abort(signal.reason),
      30_000,
    );
  };
  signal.addEventListener("abort", cancelCollection, { once: true });
  if (signal.aborted) cancelCollection();
  const collectionSignal = AbortSignal.any([
    collection.signal,
    AbortSignal.timeout(600_000),
  ]);
  let removeAbortListener = () => {};
  const collectionAborted = new Promise<never>((_, reject) => {
    const abort = () => reject(collectionSignal.reason);
    collectionSignal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () =>
      collectionSignal.removeEventListener("abort", abort);
    if (collectionSignal.aborted) abort();
  });
  try {
    // Artifact export is outside the agent budget, with no additional inference.
    results = await Promise.race([
      agent.collectResults(collectionSignal),
      collectionAborted,
    ]);
  } catch (err) {
    errors.push(err);
  } finally {
    clearTimeout(cancellationTimeout);
    removeAbortListener();
    signal.removeEventListener("abort", cancelCollection);
  }
  return {
    results,
    startedAt:
      startedAt === undefined ? null : new Date(startedAt).toISOString(),
    duration: startedAt === undefined ? 0 : (stoppedAt - startedAt) / 1000,
    startupDuration: (startupFinishedAt - startupStartedAt) / 1000,
    cleanupDuration: (finishedAt - stoppedAt) / 1000,
    partial: errors.length > 0 || stopReason !== "completed",
    stopReason: errors.length > 0 ? "failed" : stopReason,
    errors,
  };
}
