import { Sandbox, Template } from "@e2b/code-interpreter";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { runCommand } from "../evals/command";
import { Fixture } from "../evals/types";
import { deleteFixtureSandbox, sandboxLifetimeMs } from "./e2b";
import { createFixtureSandbox, fixtureTemplate } from "./launch-fixtures";

export const STARTUP_TIMEOUT_MS = 15 * 60_000;

export async function setupFixture(
  fixture: Fixture,
  options: {
    signal: AbortSignal;
    resourceMinutes: number;
    readyTtlMinutes?: number;
  },
) {
  options.signal.throwIfAborted();
  sandboxLifetimeMs(options.resourceMinutes);
  if (options.readyTtlMinutes !== undefined)
    sandboxLifetimeMs(options.readyTtlMinutes);
  const template = fixtureTemplate(fixture);
  if (
    !(await Template.exists(template.name, {
      requestTimeoutMs: 30_000,
      signal: options.signal,
    }))
  ) {
    throw new Error(
      `${fixture.name}: E2B template ${template.name} is missing. Build the Docker resource template with pnpm build-template first. See README.md.`,
    );
  }
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted();
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    ]);
    const name = `mo-eval-${randomUUID()}`;
    let sandbox: Sandbox;
    try {
      sandbox = await createFixtureSandbox(
        fixture,
        options.resourceMinutes,
        name,
      );
    } catch (creationError) {
      let recoveredId: string;
      try {
        const matches = await Sandbox.list({
          query: { metadata: { moEvalOwner: name } },
          requestTimeoutMs: 30_000,
        }).nextItems();
        if (matches.length !== 1)
          throw new Error(
            `Expected one owned E2B sandbox for ${name}; found ${matches.length}.`,
            { cause: creationError },
          );
        recoveredId = matches[0].sandboxId;
      } catch (recoveryError) {
        throw new AggregateError(
          [creationError, recoveryError],
          `${fixture.name}: creation failed (${String(creationError)}) and its sandbox could not be recovered (${String(recoveryError)}); not retrying.`,
          { cause: recoveryError },
        );
      }
      await cleanupFailedSetup(recoveredId, creationError);
      options.signal.throwIfAborted();
      if (attempt === 3) {
        // No agent has run; only setup attempts count toward this ceiling.
        throw creationError;
      }
      await retry(creationError, attempt);
      continue;
    }
    try {
      const output = await runCommand(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./launch-fixture.ts", import.meta.url)),
        ],
        {
          signal,
          timeoutMs: STARTUP_TIMEOUT_MS,
          input: JSON.stringify({
            ...options,
            signal: undefined,
            fixture,
            sandboxId: sandbox.sandboxId,
          }),
        },
      );
      const lines = output.split("\n");
      const url = new URL(z.string().parse(JSON.parse(lines.pop() ?? "")));
      process.stdout.write(`${lines.join("\n")}\n`);
      signal.throwIfAborted();
      return { sandbox, url };
    } catch (error) {
      await cleanupFailedSetup(sandbox.sandboxId, error);
      options.signal.throwIfAborted();
      if (attempt === 3) {
        // Exhausted setup retries never rerun an agent or reuse a dirty sandbox.
        throw error;
      }
      await retry(error, attempt);
    }
  }

  async function retry(error: unknown, attempt: number) {
    options.signal.throwIfAborted();
    process.stderr.write(
      `${fixture.name}: setup attempt ${attempt}/3 failed: ${String(error)}; retrying with a fresh sandbox.\n`,
    );
    await delay(1000, undefined, { signal: options.signal });
  }
}

async function cleanupFailedSetup(id: string, setupError: unknown) {
  try {
    await deleteFixtureSandbox(id);
  } catch (cleanupError) {
    throw new AggregateError(
      [setupError, cleanupError],
      `Fixture setup and deletion of ${id} both failed: ${String(setupError)}; ${String(cleanupError)}`,
      { cause: cleanupError },
    );
  }
}
