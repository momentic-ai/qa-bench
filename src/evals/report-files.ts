import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { DurationSchema } from "./reports";
import { Agent, reportDirectory } from "./scores";
import { Fixture } from "./types";

const RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_FILE = "claim.lock";

export function createRunId() {
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  return `${startedAt}-${randomUUID()}`;
}

export function parseRunIds(values: string[] | undefined) {
  for (const value of values ?? []) {
    if (!RUN_ID_PATTERN.test(value))
      throw new Error(
        `Invalid --run-id ${value}; use a run folder name such as ${createRunId()}.`,
      );
  }
  return values ?? [];
}

async function runFolders(fixtureDirectory: string) {
  try {
    return (await readdir(fixtureDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return [];
    throw err;
  }
}

export async function findReportRun(
  reportsDirectory: string,
  agent: Agent,
  fixture: string,
  runIds: readonly string[] = [],
): Promise<{ reportsDirectory: string; directory: string; runId?: string }> {
  for (const root of [
    reportsDirectory,
    path.join(reportsDirectory, "archive"),
  ]) {
    const fixtureDirectory = reportDirectory(agent, fixture, root);
    const runs = await runFolders(fixtureDirectory);
    const runId = runIds.find((id) => runs.includes(id));
    if (runId)
      return {
        reportsDirectory: root,
        directory: path.join(fixtureDirectory, runId),
        runId,
      };
  }
  const fixtureDirectory = reportDirectory(agent, fixture, reportsDirectory);
  // Run IDs sort by start time; unfinished runs have no duration.json yet.
  const runId = (await runFolders(fixtureDirectory)).find((id) =>
    existsSync(path.join(fixtureDirectory, id, "duration.json")),
  );
  if (!runId) return { reportsDirectory, directory: fixtureDirectory };
  return {
    reportsDirectory,
    directory: path.join(fixtureDirectory, runId),
    runId,
  };
}

async function claim(directory: string) {
  try {
    await writeFile(path.join(directory, CLAIM_FILE), `${process.pid}\n`, {
      flag: "wx",
    });
    return "claimed";
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST")
      return "busy";
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return "missing";
    throw err;
  }
}

async function release(directory: string) {
  await rm(path.join(directory, CLAIM_FILE), { force: true });
}

export async function claimReportRun(
  reportsDirectory: string,
  agent: Agent,
  fixture: string,
  runId: string | undefined,
  signal?: AbortSignal,
) {
  let directory = reportDirectory(agent, fixture, reportsDirectory);
  for (let attempt = 0; attempt < 100; attempt++) {
    let run = { reportsDirectory, directory };
    if (runId) {
      // A concurrent startup may have archived the run since it was selected.
      const found = await findReportRun(reportsDirectory, agent, fixture, [
        runId,
      ]);
      if (found.runId !== runId)
        throw new Error(
          `Run ${runId} no longer exists for ${agent}/${fixture} in ${reportsDirectory}.`,
        );
      run = found;
    }
    directory = run.directory;
    const result = await claim(directory);
    if (result === "claimed")
      return { ...run, runId, release: () => release(directory) };
    if (result === "missing" && !runId)
      return { ...run, runId, release: async () => {} };
    await setTimeout(100, undefined, { signal });
  }
  throw new Error(
    `${directory} is being graded by another process; delete ${CLAIM_FILE} there if none is running.`,
  );
}

export async function archivePreviousReports(
  fixtures: Fixture[],
  reportsDirectory: string,
  agent: string,
  currentRunId: string,
) {
  const scoresArchive = path.join(reportsDirectory, "archive", agent, "scores");
  await mkdir(scoresArchive, { recursive: true });
  await renameIfPresent(
    path.join(reportsDirectory, agent, "scores.csv"),
    path.join(scoresArchive, `${randomUUID()}.csv`),
  );
  for (const fixture of fixtures) {
    const previous = path.join(reportsDirectory, agent, fixture.name);
    const fixtureArchive = path.join(
      reportsDirectory,
      "archive",
      agent,
      fixture.name,
    );
    let entries;
    try {
      entries = (await readdir(previous)).filter((entry) => entry !== "areas");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT")
        continue;
      throw err;
    }
    const legacy = entries.filter(
      (entry) => !RUN_ID_PATTERN.test(entry) && entry !== CLAIM_FILE,
    );
    const archives: string[] = [];
    // Graders hold the same claim, so claimed reports are never moved mid-grade.
    if (legacy.length && (await claim(previous)) === "claimed") {
      try {
        const archive = path.join(fixtureArchive, randomUUID());
        await mkdir(archive, { recursive: true });
        let moved = false;
        for (const entry of legacy) {
          if (
            await renameIfPresent(
              path.join(previous, entry),
              path.join(archive, entry),
            )
          )
            moved = true;
        }
        if (moved) archives.push(archive);
        else await rmdir(archive);
      } finally {
        await release(previous);
      }
    }
    for (const runId of entries.filter((entry) => RUN_ID_PATTERN.test(entry))) {
      const run = path.join(previous, runId);
      // Grading writes scores.csv last, so runs without it are still running or ungraded.
      if (
        runId === currentRunId ||
        !existsSync(path.join(run, "scores.csv")) ||
        (await claim(run)) !== "claimed"
      )
        continue;
      const archive = path.join(fixtureArchive, runId);
      let moved = false;
      try {
        if (existsSync(path.join(run, "scores.csv"))) {
          await mkdir(fixtureArchive, { recursive: true });
          moved = await renameIfPresent(run, archive);
        }
      } finally {
        await release(moved ? archive : run);
      }
      if (moved) archives.push(archive);
    }
    try {
      await rmdir(previous);
    } catch (err) {
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err.code === "ENOTEMPTY" || err.code === "ENOENT")
        )
      )
        throw err;
    }
    for (const archive of archives)
      process.stdout.write(
        `${fixture.name}: Previous report archived to ${archive}\n`,
      );
  }
}

async function renameIfPresent(source: string, destination: string) {
  try {
    await rename(source, destination);
    return true;
  } catch (err) {
    // A concurrent startup may have archived the same report first.
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      return false;
    throw err;
  }
}

export async function saveCaseMetadata(directory: string, fixture: Fixture) {
  if (fixture.pullRequest) {
    // Keep the tested commits with the findings when the case definition changes.
    await writeFile(
      path.join(directory, "case.json"),
      `${JSON.stringify({ pullRequest: fixture.pullRequest, revisionSha: fixture.revisionSha }, null, 2)}\n`,
    );
  }
}

export async function verifyCaseMetadata(directory: string, fixture: Fixture) {
  if (fixture.pullRequest) {
    // Scores from different pinned commits cannot be compared as the same PR case.
    const saved = JSON.parse(
      await readFile(path.join(directory, "case.json"), "utf8"),
    );
    const expected = {
      pullRequest: fixture.pullRequest,
      revisionSha: fixture.revisionSha,
    };
    if (!isDeepStrictEqual(saved, expected)) {
      // The case may have changed while its ground-truth labels stayed the same.
      throw new Error(
        `PR case changed for ${fixture.name}; rerun this agent's eval in ${directory}.`,
      );
    }
  }
}

export async function readReportDuration(directory: string) {
  const { duration, valid } = DurationSchema.parse(
    JSON.parse(await readFile(path.join(directory, "duration.json"), "utf8")),
  );
  if (valid === false || !Number.isFinite(duration) || duration <= 0) {
    // Rates require a measured, positive duration.
    throw new Error(`Invalid report duration in ${directory}.`);
  }
  return duration;
}

export async function readOptionalCost(directory: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(path.join(directory, "cost.json"), "utf8"),
    );
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // A failed cost export must not discard otherwise usable findings.
      return null;
    }
    throw err;
  }
}
