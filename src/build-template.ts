import { Template } from "@e2b/code-interpreter";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { DOCKER_INSTALL, dockerTemplateName } from "./fixtures/e2b";

async function main() {
  const { values } = parseArgs({
    options: {
      cpu: { type: "string", default: "2" },
      memory: { type: "string", default: "4" },
      rebuild: { type: "boolean", default: false },
      timeout: { type: "string", default: "5400" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      "Build the E2B Docker host template.\nUsage: build-template [--cpu 2 --memory 4] [--rebuild] [--timeout <seconds>]\n",
    );
    return;
  }
  const timeout = Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86400) {
    throw new Error(
      "--timeout must be a positive integer up to 86400 seconds.",
    );
  }
  const cpu = Number(values.cpu);
  const memory = Number(values.memory);
  if (
    !Number.isSafeInteger(cpu) ||
    cpu <= 0 ||
    !Number.isSafeInteger(memory) ||
    memory <= 0
  ) {
    throw new Error(
      "--cpu and --memory must be positive integers (memory in GiB).",
    );
  }
  const directory = path.resolve(import.meta.dirname, "../build/templates");
  const name = dockerTemplateName({ cpu, memory });
  const resources = { cpu, memory, disk: 10 };
  const template = Template()
    .fromBaseImage()
    .runCmd(DOCKER_INSTALL, { user: "root" });
  if (!values.rebuild && (await Template.exists(name))) {
    process.stdout.write(
      `${name}: already built. Use --rebuild to replace it.\n`,
    );
    return;
  }
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Template build interrupted."));
  const timer = setTimeout(
    () => controller.abort(new Error(`Template build exceeded ${timeout}s.`)),
    timeout * 1000,
  );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let build;
  try {
    build = await Template.buildInBackground(template, name, {
      cpuCount: resources.cpu,
      memoryMB: resources.memory * 1024,
      skipCache: values.rebuild,
      requestTimeoutMs: 60_000,
      signal: controller.signal,
    });
    process.stderr.write(`E2B build ${build.templateId}/${build.buildId}\n`);
    let logsOffset = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const status = await Template.getBuildStatus(build, {
        logsOffset,
        requestTimeoutMs: 30_000,
        signal: controller.signal,
      });
      for (const log of status.logEntries)
        process.stderr.write(`${log.message}\n`);
      logsOffset += status.logEntries.length;
      if (status.status === "ready") break;
      if (status.status === "error")
        throw new Error(`${name}: ${JSON.stringify(status.reason)}`);
      await delay(2000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (build)
      process.stderr.write(
        `E2B build ${build.templateId}/${build.buildId} did not complete locally. E2B's SDK has no per-build cancellation API; check this build in E2B. No shared template was deleted.\n`,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  const receipt = {
    provider: "e2b",
    name,
    templateId: build.templateId,
    buildId: build.buildId,
    resources,
  };
  await mkdir(path.join(directory, name), { recursive: true });
  await writeFile(
    path.join(directory, name, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}

await main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
