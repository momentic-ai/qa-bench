import { execFile } from "node:child_process";
import { cp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fixtureAccounts } from "../../evals/bugbash-brief";
import { AgentCost, getE2EModelCost } from "../../evals/cost";
import { Fixture } from "../../evals/types";
import { E2EModel } from "./config";

const root = path.resolve(import.meta.dirname, "../../..");

// e2e refuses credentials with shorter passwords.
const MIN_PASSWORD_LENGTH = 6;

/** Brief text for an e2e run: how it's set up and which accounts e2e can sign in as. */
export function e2eInstructions(fixture: Fixture) {
  const accounts = fixture.username ? fixtureAccounts(fixture) : [];
  const usable = accounts.filter(
    (account) => account.password.length >= MIN_PASSWORD_LENGTH,
  );
  const unusable = accounts.filter((account) => !usable.includes(account));
  return [
    "e2e is set up in your working directory, with an e2e.config.ts for the app. Run a bug bash with the e2e skill and save each bug it confirms.",
    usable.length > 0 &&
      `The config declares these accounts as e2e credentials: ${usable.map((account) => account.name).join(", ")}.`,
    unusable.length > 0 &&
      `e2e can't sign in as ${unusable.map((account) => account.username).join(", ")}: e2e needs passwords of at least ${MIN_PASSWORD_LENGTH} characters.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Sets up the project the e2e skill expects: the CLI, the skill, and a config
 * that targets the fixture. `broker` is a Browserbase broker URL; without it
 * e2e launches local Chromium.
 */
export async function prepareE2E({
  workspace,
  skillOwner,
  fixture,
  targetUrl,
  model,
  journal,
  broker,
}: {
  workspace: string;
  skillOwner: ".agents" | ".claude";
  fixture: Fixture;
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
  // Passwords come from the environment, as e2e expects, not from the config file.
  const accounts = (fixture.username ? fixtureAccounts(fixture) : []).filter(
    (account) => account.password.length >= MIN_PASSWORD_LENGTH,
  );
  const passwordVariable = (name: string) =>
    `E2E_PASSWORD_${name.toUpperCase().replaceAll("-", "_")}`;
  const credentials = accounts
    .map(
      ({ name, username }) =>
        `    ${JSON.stringify(name)}: { username: ${JSON.stringify(username)}, password: process.env.${passwordVariable(name)} ?? "" },`,
    )
    .join("\n");
  await writeFile(
    path.join(workspace, "e2e.config.ts"),
    `import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { meteredModel } from ${JSON.stringify(path.join(import.meta.dirname, "config.ts"))};

export default {
  targets: [{ engine: ${engine}, app: { url: ${JSON.stringify(targetUrl.href)} } }],
  credentials: {
${credentials}
  },
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
    ...Object.fromEntries(
      accounts.map(({ name, password }) => [passwordVariable(name), password]),
    ),
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
