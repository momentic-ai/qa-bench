import { setupSandboxCleanup } from "./cleanup";
import { setupFixture } from "./setup-fixture";
import { BenchmarkSandbox, Fixture } from "./types";

export class FixtureExecution implements AsyncDisposable {
  private readonly cleanup;

  constructor(options: { signal?: AbortSignal } = {}) {
    this.cleanup = setupSandboxCleanup(options);
  }

  get signal(): AbortSignal {
    return this.cleanup.signal;
  }

  async provision(fixture: Fixture, timeLimitMs: number) {
    this.signal.throwIfAborted();
    const setup = await setupFixture(fixture, {
      // Startup and artifact collection must not consume the agent's execution budget.
      resourceMinutes: Math.ceil(timeLimitMs / 60_000) + 60,
      signal: this.signal,
    });
    this.cleanup.track(setup.sandbox);
    return setup;
  }

  release(sandbox: BenchmarkSandbox): Promise<void> {
    return this.cleanup.deleteSandbox(sandbox);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup.dispose();
  }
}
