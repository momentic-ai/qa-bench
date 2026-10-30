import path from "node:path";

export type ExecutionOptions = {
  concurrency?: number;
  timeLimitMs?: number;
  outputDirectory?: string;
};

export const executionOptions = {
  concurrency: { type: "string" },
  minutes: { type: "string" },
  "output-dir": { type: "string" },
} as const;

export function resolveOutputDirectory(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error("--output-dir requires a path.");
  return path.resolve(value);
}

export function parseExecutionOptions(values: {
  concurrency?: string;
  minutes?: string;
  "output-dir"?: string;
}): ExecutionOptions {
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number(values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("--concurrency must be a positive integer.");
    }
  }
  let timeLimitMs: number | undefined;
  if (values.minutes !== undefined) {
    if (
      !/^\d+$/.test(values.minutes) ||
      Number(values.minutes) < 1 ||
      Number(values.minutes) > 120
    ) {
      throw new Error("--minutes must be an integer from 1 to 120.");
    }
    timeLimitMs = Number(values.minutes) * 60_000;
  }
  return {
    concurrency,
    timeLimitMs,
    outputDirectory: resolveOutputDirectory(values["output-dir"]),
  };
}
