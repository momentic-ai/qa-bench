import { parseArgs } from "node:util";

import { e2bFixture, runFixtures } from "./fixtures";
import { listAppFixtureNames, selectBenchmarkFixtures } from "./fixtures/files";
import { STARTUP_TIMEOUT_MS } from "./fixtures/setup-fixture";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      timeout: { type: "string", default: "1h" },
      all: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
    strict: true,
  });

  const duration = /^(\d+)(s|m|h)$/.exec(values.timeout);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  const timeoutMs = duration ? Number(duration[1]) * unitMs[duration[2]] : 0;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 86_400_000 - STARTUP_TIMEOUT_MS
  ) {
    // Explicit units and bounded timers prevent accidental immediate or unbounded shutdown.
    throw new Error(
      "--timeout requires a positive duration up to 23h45m, e.g. 30s, 30m, or 2h.",
    );
  }
  if (values.all && positionals.length) {
    // An explicit selection and the whole catalog are mutually exclusive.
    throw new Error("Use fixture names or --all, not both.");
  }
  if (!positionals.length && !values.all && !values.list) {
    // Listing is safe; starting every paid sandbox requires an explicit selection.
    throw new Error(
      "Use pnpm start-fixture <fixture...> --timeout 30m, --all, or --list.",
    );
  }
  let requestedNames = positionals;
  if (!positionals.length) requestedNames = await listAppFixtureNames();
  const fixtures = await selectBenchmarkFixtures({ requestedNames });
  if (values.list) {
    // Discovery and manifest validation need no E2B or model API calls.
    fixtures.forEach((fixture) => process.stdout.write(`${fixture.name}\n`));
  } else {
    // All backends expose the same start/stop contract; this catalog uses E2B.
    const controller = new AbortController();
    const onInterrupt = () => {
      process.exitCode = 130;
      controller.abort();
    };
    const onTerminate = () => {
      process.exitCode = 143;
      controller.abort();
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    try {
      const success = await runFixtures(
        fixtures.map((fixture) => e2bFixture(fixture)),
        { timeoutMs, signal: controller.signal },
      );
      if (!success && !process.exitCode) {
        // Failed startup or deletion remains visible to shell automation.
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
