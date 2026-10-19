import { fixtureAccounts } from "./evals/bugbash-brief";
import { WebFixture } from "./evals/types";
import { deleteFixtureSandbox } from "./fixtures/e2b";
import { STARTUP_TIMEOUT_MS, setupFixture } from "./fixtures/setup-fixture";

export interface FixtureStartOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

export interface StartedFixture {
  info: Record<string, string>;
  stop(): Promise<void>;
}

export interface StartableFixture {
  name: string;
  start(options: FixtureStartOptions): Promise<StartedFixture>;
}

export function e2bFixture(fixture: WebFixture): StartableFixture {
  return {
    name: fixture.name,
    async start({ timeoutMs, signal }) {
      const accounts = fixtureAccounts(fixture);
      const { sandbox, url } = await setupFixture(fixture, {
        signal,
        resourceMinutes: Math.ceil((STARTUP_TIMEOUT_MS + timeoutMs) / 60_000),
        readyTtlMinutes: Math.ceil(timeoutMs / 60_000),
      });
      let deletion: Promise<void> | undefined;
      function stop() {
        deletion ??= deleteFixtureSandbox(sandbox.sandboxId).then(
          () => undefined,
        );
        return deletion;
      }
      if (fixture.entryPath) {
        // Preserve the signed query while opening the fixture's entry page.
        url.pathname = fixture.entryPath;
      }
      return {
        info: {
          URL: url.href,
          Username: fixture.username,
          Password: fixture.password,
          ...Object.fromEntries(
            accounts
              .slice(1)
              .map((account) => [
                `Account ${account.name}`,
                `${account.username} / ${account.password} (${account.role})`,
              ]),
          ),
          ...(fixture.authentication
            ? { Authentication: fixture.authentication }
            : {}),
          Sandbox: sandbox.sandboxId,
          Timeout: `${Math.ceil(timeoutMs / 60_000)}m (E2B timeout)`,
        },
        stop,
      };
    },
  };
}

export async function runFixtures(
  fixtures: StartableFixture[],
  options: FixtureStartOptions,
  write: (message: string) => void = (message) => process.stdout.write(message),
) {
  const started: { name: string; fixture: StartedFixture }[] = [];
  function reportFailure(name: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    write(`${name} failed\n    Error: ${message.replaceAll("\n", "\n    ")}\n`);
  }
  const results = await Promise.allSettled(
    fixtures.map((fixture) =>
      (async () => {
        let running: StartedFixture | undefined;
        const startup = new AbortController();
        const signal = AbortSignal.any([options.signal, startup.signal]);
        const startupTimer = setTimeout(
          () =>
            startup.abort(new Error("Fixture startup exceeded 15 minutes.")),
          STARTUP_TIMEOUT_MS,
        );
        try {
          running = await fixture.start({
            ...options,
            signal,
          });
          clearTimeout(startupTimer);
          signal.throwIfAborted();
          write(`${fixture.name} launched successfully\n`);
          for (const [key, value] of Object.entries(running.info)) {
            write(`    ${key}: ${value.replaceAll("\n", "\n    ")}\n`);
          }
          signal.throwIfAborted();
          started.push({ name: fixture.name, fixture: running });
        } catch (error) {
          if (running) {
            // A returned resource is still ours until startup and printing both succeed.
            try {
              await running.stop();
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `${fixture.name}: startup and cleanup failed: ${String(error)}; ${String(cleanupError)}`,
                { cause: cleanupError },
              );
            }
          }
          if (
            !options.signal.aborted ||
            (error !== options.signal.reason &&
              !(error instanceof Error && error.name === "AbortError"))
          ) {
            // Cancellation is expected; startup and cleanup failures still need reporting.
            throw error;
          }
        } finally {
          clearTimeout(startupTimer);
        }
      })().catch((error: unknown) => {
        // Report each failure immediately, while other fixtures remain available.
        reportFailure(fixture.name, error);
        throw error;
      }),
    ),
  );
  if (options.signal.aborted) {
    // Ctrl-C while siblings are starting must also reclaim already-ready fixtures.
    const cleanup = await Promise.allSettled(
      started.map(async ({ name, fixture }) => {
        try {
          await fixture.stop();
          write(`${name} stopped\n`);
        } catch (err) {
          reportFailure(name, err);
          throw err;
        }
      }),
    );
    results.push(...cleanup);
  }
  return results.every((result) => result.status === "fulfilled");
}
