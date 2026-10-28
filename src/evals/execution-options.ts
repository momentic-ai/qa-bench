import path from "node:path";

export type ExecutionOptions = {
  concurrency?: number;
  outputDirectory?: string;
};

export const executionOptions = {
  concurrency: { type: "string" },
  "output-dir": { type: "string" },
} as const;

export function resolveOutputDirectory(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error("--output-dir requires a path.");
  return path.resolve(value);
}

export function parseExecutionOptions(values: {
  concurrency?: string;
  "output-dir"?: string;
}): ExecutionOptions {
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number(values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("--concurrency must be a positive integer.");
    }
  }
  return {
    concurrency,
    outputDirectory: resolveOutputDirectory(values["output-dir"]),
  };
}
