import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";

import { FixtureDeploymentSchema, FixtureSchema } from "../evals/types";
import { sandboxLifetimeMs } from "./e2b";
import { launchFixture } from "./launch-fixtures";

const input = z.object({
  sandboxId: z.string(),
  resourceMinutes: z.number().int().positive(),
  readyTtlMinutes: z.number().int().positive().optional(),
  fixture: FixtureSchema.safeExtend({
    type: z.literal("full-app"),
    name: z.string(),
    directory: z.string(),
    groundTruthFile: z.string(),
    fullAppGroundTruthFile: z.string().optional(),
    deployment: FixtureDeploymentSchema,
  }),
});

// A process boundary lets cancellation close SDK requests that expose no AbortSignal.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const options = input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
const sandbox = await Sandbox.connect(options.sandboxId, {
  requestTimeoutMs: 30_000,
  timeoutMs: sandboxLifetimeMs(options.resourceMinutes),
});
const url = await launchFixture(sandbox, options.fixture);
if (options.readyTtlMinutes !== undefined) {
  await sandbox.setTimeout(sandboxLifetimeMs(options.readyTtlMinutes));
}
process.stdout.write(`${JSON.stringify(url.href)}\n`);
