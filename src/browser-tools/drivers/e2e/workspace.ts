import { execFile } from "node:child_process";
import { copyFile, cp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AgentCost } from "../../../agents/types";
import { fixtureAccounts } from "../../../fixtures/accounts";
import { Fixture } from "../../../fixtures/types";
import { writeJson } from "../../../shared/json-file";
import { getE2EModelCost } from "./cost";
import { E2EModel, E2ESetup, E2E_SETUP_VARIABLE } from "./harness";

const root = path.resolve(import.meta.dirname, "../../../..");

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
 * that targets the fixture. Returns the agent shell's environment, which the
 * config reads its settings from. `broker` is a Browserbase broker URL;
 * without it e2e launches local Chromium. `settingsRecord` gets the settings
 * without passwords, as run evidence.
 */
export async function prepareE2E({
  workspace,
  skillOwner,
  fixture,
  targetUrl,
  model,
  journal,
  settingsRecord,
  broker,
}: {
  workspace: string;
  skillOwner: ".agents" | ".claude";
  fixture: Fixture;
  targetUrl: URL;
  model: E2EModel;
  journal: string;
  settingsRecord: string;
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
  for (const file of ["e2e.config.ts", "harness.ts"])
    await copyFile(
      path.join(import.meta.dirname, file),
      path.join(workspace, file),
    );
  await writeFile(journal, "");
  const accounts = (fixture.username ? fixtureAccounts(fixture) : []).filter(
    (account) => account.password.length >= MIN_PASSWORD_LENGTH,
  );
  const setup: E2ESetup = {
    targetUrl: targetUrl.href,
    broker,
    model,
    journal,
    credentials: Object.fromEntries(
      accounts.map(({ name, username, password }) => [
        name,
        { username, password },
      ]),
    ),
  };
  await writeJson(settingsRecord, {
    ...setup,
    credentials: Object.fromEntries(
      accounts.map(({ name, username }) => [name, { username }]),
    ),
  });
  return {
    PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH || ""}`,
    [E2E_SETUP_VARIABLE]: JSON.stringify(setup),
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
