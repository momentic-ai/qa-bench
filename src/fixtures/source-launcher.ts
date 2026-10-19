import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  BenchmarkSandbox,
  Fixture,
  FixtureDeploymentFile,
} from "../evals/types";
import { START_DOCKER, executeFixtureCommand } from "./e2b";
import { selectRuntimeScript } from "./files";

export async function launchSourceFixture(
  sandbox: BenchmarkSandbox,
  fixture: Fixture,
) {
  const ready = await executeFixtureCommand(
    sandbox,
    START_DOCKER,
    undefined,
    undefined,
    90,
  );
  if (ready.exitCode !== 0) {
    throw new Error("Docker did not start in the E2B sandbox.");
  }

  const { deployment } = fixture;
  const files = deployment.compose;
  const remoteDirectory = await uploadFixtureToSandbox(sandbox, fixture, files);
  const url = new URL(`https://${sandbox.getHost(fixture.port)}`);
  const environment = {
    FIXTURE_URL: url.href,
    FIXTURE_ORIGIN: url.origin,
    FIXTURE_HOST: url.hostname,
    FIXTURE_PORT: String(fixture.port),
    FIXTURE_USERNAME: fixture.username,
    FIXTURE_PASSWORD: fixture.password,
    FIXTURE_CASE: fixture.name,
    FIXTURE_SEED_SCRIPT: `/fixture/${selectRuntimeScript(files, "seed.sh") ?? selectRuntimeScript(files, "seed.mjs") ?? "app/seed.sh"}`,
    ...fixture.runtimeEnvironment,
    COMPOSE_FILE: deployment.composeFiles.join(":"),
  };
  const started = await executeFixtureCommand(
    sandbox,
    "docker compose up -d --wait",
    remoteDirectory,
    environment,
    600,
  );
  if (started.exitCode !== 0) {
    let detail = started.result;
    try {
      const logs = await executeFixtureCommand(
        sandbox,
        "docker compose logs --no-color --tail=80",
        remoteDirectory,
        environment,
        30,
      );
      if (logs.result) {
        detail = `${started.result}\n${logs.result}`;
      }
    } catch {
      // Preserve the original startup error when logs are unavailable.
    }
    throw new Error(`${fixture.name} did not start: ${detail}`);
  }
  process.stdout.write(`${fixture.name}: fixture preview ready.\n`);
  return url;
}

async function uploadFixtureToSandbox(
  sandbox: BenchmarkSandbox,
  fixture: Fixture,
  files: FixtureDeploymentFile[],
  remoteDirectory = path.posix.join("/home", fixture.name),
) {
  await sandbox.files.makeDir(remoteDirectory, { user: "root" });
  for (const { target, source } of files) {
    await sandbox.files.makeDir(
      path.posix.dirname(path.posix.join(remoteDirectory, target)),
      { user: "root" },
    );
    await sandbox.files.write(
      path.posix.join(remoteDirectory, target),
      new Uint8Array(await readFile(source)).buffer,
      { user: "root" },
    );
  }
  return remoteDirectory;
}
