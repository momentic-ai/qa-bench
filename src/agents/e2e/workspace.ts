import { execFile } from "node:child_process";
import { cp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getE2EModelCost } from "../../evals/cost";
import { AgentCost } from "../codex/codex-runner";
import { E2EModel } from "./config";

const root = path.resolve(import.meta.dirname, "../../..");

export const E2E_INSTRUCTIONS =
  "e2e is set up in your working directory, with an e2e.config.ts for the app. Run a bug bash with the e2e skill and save each bug it confirms.";

/**
 * Sets up the project the e2e skill expects: the CLI, the skill, and a config
 * that targets the fixture. `broker` is a Browserbase broker URL; without it
 * e2e launches local Chromium.
 */
export async function prepareE2E({
  workspace,
  skillOwner,
  targetUrl,
  model,
  journal,
  broker,
}: {
  workspace: string;
  skillOwner: ".agents" | ".claude";
  targetUrl: URL;
  model: E2EModel;
  journal: string;
  broker?: string;
}) {
  await symlink(
    path.join(root, "node_modules"),
    path.join(workspace, "node_modules"),
  );
  await cp(
    path.join(root, "node_modules/e2e/skills/e2e"),
    path.join(workspace, skillOwner, "skills/e2e"),
    { recursive: true },
  );
  await writeFile(journal, "");
  const engine = broker
    ? `web({ connect: { cdpEndpoint: () => ${JSON.stringify(broker)} } })`
    : "web()";
  const effort =
    model.provider === "openai"
      ? { openai: { reasoningEffort: "medium" } }
      : { anthropic: { effort: "medium" } };
  await writeFile(
    path.join(workspace, "e2e.config.ts"),
    `import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { meteredModel } from ${JSON.stringify(path.join(import.meta.dirname, "config.ts"))};

export default {
  targets: [{ engine: ${engine}, app: { url: ${JSON.stringify(targetUrl.href)} } }],
  agents: {
    default: {
      model: meteredModel(${JSON.stringify(model)}, ${JSON.stringify(journal)}),
      providerOptions: ${JSON.stringify(effort)},
    },
  },
} satisfies E2EConfig;
`,
  );
  return {
    PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH || ""}`,
  };
}

/** Fails on a Node.js that e2e's loader can't run on, as the agent's shell would. */
export async function validateE2E() {
  await promisify(execFile)(
    path.join(root, "node_modules/.bin/e2e"),
    ["--version"],
    { timeout: 30_000 },
  );
}

/** Adds e2e's model spend to the agent's cost; an unreadable journal leaves it incomplete. */
export async function addE2ECost(cost: AgentCost | null, journal: string) {
  const e2e = await getE2EModelCost(journal).catch((err) => {
    process.stderr.write(`Could not price e2e model calls: ${err}\n`);
    return null;
  });
  const estimatedUsd = cost?.estimatedUsd ?? null;
  return {
    ...cost,
    estimatedUsd:
      estimatedUsd === null || e2e === null
        ? null
        : estimatedUsd + e2e.estimatedUsd,
    ...(e2e === null ? { costComplete: false } : {}),
    e2eModel: e2e,
  };
}
