import { setupSandboxCleanup } from "../evals/sandbox";
import { BenchmarkSandbox, WebFixture } from "../evals/types";
import { TIMEOUT_MS } from "../tasks/full-app/options";
import { setupFixture } from "./setup-fixture";

export class FixtureExecution implements AsyncDisposable {
  private readonly cleanup;

  constructor(options: { signal?: AbortSignal } = {}) {
    this.cleanup = setupSandboxCleanup(options);
  }

  get signal(): AbortSignal {
    return this.cleanup.signal;
  }

  async provision(fixture: WebFixture) {
    this.signal.throwIfAborted();
    const setup = await setupFixture(fixture, {
      // Startup and artifact collection must not consume the agent's execution budget.
      resourceMinutes: Math.ceil(TIMEOUT_MS / 60_000) + 60,
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
