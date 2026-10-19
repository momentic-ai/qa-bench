import { readdir } from "node:fs/promises";

import {
  OSS_FIXTURES_DIRECTORY,
  expandAppFixtureNames,
  loadAppDeployment,
  resolveAppFixture,
  selectBenchmarkFixtures,
  selectFixtureNames,
} from "../fixtures/files";
import { PRODUCT_AREAS_DIRECTORY } from "./dataset";
import { readGroundTruth } from "./ground-truth";
import { Fixture } from "./types";

export async function selectComparisonFixtures(
  selection?: string,
): Promise<Fixture[]> {
  const requestedNames = selection?.split(",").map((name) => name.trim()) ?? [];
  if (requestedNames.some((name) => !name)) {
    throw new Error("--fixtures requires comma-separated fixture names.");
  }
  let fixtures: Fixture[];
  if (requestedNames.length) {
    fixtures = await selectNamedAppFixtures(requestedNames);
  } else {
    // Default evals include only apps with grading references; explicit names must validate them.
    fixtures = await selectBenchmarkFixtures({
      requestedNames,
      filterFixture: async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.some(
          (entry) =>
            (entry.isFile() && entry.name === "ground-truth.json") ||
            (entry.isDirectory() && entry.name === PRODUCT_AREAS_DIRECTORY),
        );
      },
    });
  }
  await Promise.all(fixtures.map(readGroundTruth));
  return fixtures;
}

async function selectNamedAppFixtures(
  requestedNames: string[],
): Promise<Fixture[]> {
  const availableNames = await selectFixtureNames(OSS_FIXTURES_DIRECTORY, []);
  const names = [...new Set(await expandAppFixtureNames(requestedNames))];
  const unknownNames = names.filter(
    (name) => !name.includes("/") && !availableNames.includes(name),
  );
  if (unknownNames.length) {
    throw new Error(
      `Unknown fixture(s): ${unknownNames.join(", ")}. Available: ${availableNames.join(", ")}.`,
    );
  }
  const fixtures = await Promise.all(
    names.map(async (selection) => {
      const { name, directory } = await resolveAppFixture(selection);
      return loadAppDeployment(name, directory);
    }),
  );
  const seenNames = new Set<string>();
  return fixtures.filter(({ name }) => {
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });
}
