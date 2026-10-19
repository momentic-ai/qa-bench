import { Sandbox } from "@e2b/code-interpreter";

import { BenchmarkSandbox, Fixture } from "../evals/types";
import {
  dockerTemplateName,
  executeFixtureCommand,
  sandboxLifetimeMs,
} from "./e2b";
import { launchSourceFixture } from "./source-launcher";

export function fixtureTemplate(fixture: Fixture) {
  const resources = fixture.sandboxResources ?? { cpu: 2, memory: 4, disk: 10 };
  return {
    name: fixture.e2bTemplate ?? dockerTemplateName(resources),
    resources,
  };
}

export async function createFixtureSandbox(
  fixture: Fixture,
  ttlMinutes: number,
  name: string,
): Promise<BenchmarkSandbox> {
  return Sandbox.create(fixtureTemplate(fixture).name, {
    timeoutMs: sandboxLifetimeMs(ttlMinutes),
    requestTimeoutMs: 180_000,
    metadata: { moEvalOwner: name, fixture: fixture.name },
  });
}

export async function launchFixture(
  sandbox: BenchmarkSandbox,
  fixture: Fixture,
) {
  const { resources } = fixtureTemplate(fixture);
  const info = await sandbox.getInfo();
  if (
    info.memoryMB < resources.memory * 1024 ||
    info.cpuCount < resources.cpu
  ) {
    throw new Error(
      `${fixture.name}: E2B template must provide at least ${resources.cpu} CPUs and ${resources.memory} GiB memory.`,
    );
  }
  const disk = await executeFixtureCommand(
    sandbox,
    "df -B1 --output=size /var/lib/docker | tail -1",
  );
  if (
    disk.exitCode !== 0 ||
    !Number.isFinite(Number(disk.result.trim())) ||
    Number(disk.result.trim()) < resources.disk * 1_000_000_000
  ) {
    throw new Error(
      `${fixture.name}: E2B template disk does not reach ${resources.disk} GB: ${disk.result}`,
    );
  }
  return launchSourceFixture(sandbox, fixture);
}
