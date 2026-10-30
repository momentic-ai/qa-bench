import path from "node:path";

export type ExecutionOptions = {
  concurrency?: number;
  timeLimitMs?: number;
  outputDirectory?: string;
};

export const executionOptions = {
  concurrency: { type: "string" },
  minutes: { type: "string" },
  "time-limit": { type: "string" },
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
  "time-limit"?: string;
  "output-dir"?: string;
}): ExecutionOptions {
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number(values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("--concurrency must be a positive integer.");
    }
  }
  if (values.minutes !== undefined && values["time-limit"] !== undefined) {
    throw new Error("Use either --time-limit or --minutes, not both.");
  }
  let duration = values["time-limit"];
  if (values.minutes !== undefined) {
    if (
      !/^\d+$/.test(values.minutes) ||
      Number(values.minutes) < 1 ||
      Number(values.minutes) > 120
    ) {
      throw new Error("--minutes must be an integer from 1 to 120.");
    }
    duration = `${values.minutes}m`;
  }
  let timeLimitMs: number | undefined;
  if (duration !== undefined) {
    timeLimitMs = parseDuration(duration);
  }
  return {
    concurrency,
    timeLimitMs,
    outputDirectory: resolveOutputDirectory(values["output-dir"]),
  };
}

function parseDuration(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(duration);
  if (!match) {
    throw new Error(
      "--time-limit requires a positive duration, e.g. 30s, 15m or 2h.",
    );
  }
  const units = { s: 1000, m: 60_000, h: 3_600_000 };
  const unit = match[2];
  if (unit !== "s" && unit !== "m" && unit !== "h") {
    throw new Error("Unsupported time-limit unit.");
  }
  const milliseconds = Number(match[1]) * units[unit];
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 24 * 60 * 60 * 1000
  ) {
    throw new Error("--time-limit must be between 1ms and 1 day.");
  }
  return milliseconds;
}
