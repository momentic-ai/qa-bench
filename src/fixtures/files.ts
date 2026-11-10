import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { Fixture, FixtureRecipeSchema, FixtureSchema } from "../evals/types";
import { DeploymentLayer, resolveDeployment } from "./deployment";

const runCommand = promisify(execFile);

const packageDirectory = path.resolve(import.meta.dirname, "../..");
export const OSS_FIXTURES_DIRECTORY = path.join(
  packageDirectory,
  "fixtures",
  "web",
  "oss",
);

/** Resolves `<app>`, `oss/<app>` (full-app) and `[oss/]<app>/areas/<area>` to a fixture directory. */
export async function resolveAppFixture(selection: string) {
  const parts = selection.split("/");
  if (parts[0] !== "oss") parts.unshift("oss");
  const [namespace, basename, variant, area] = parts;
  const root = OSS_FIXTURES_DIRECTORY;
  const invalidMessage = `Invalid fixture: ${selection}. Use <app>, oss/<app> or oss/<app>/areas/<area>.`;
  if (parts.length > 4 || namespace !== "oss" || !basename) {
    throw new Error(invalidMessage);
  }
  if (variant !== undefined && (variant !== "areas" || !area)) {
    throw new Error(invalidMessage);
  }
  await selectFixtureNames(root, [basename]);
  if (variant === "areas") {
    const available = await productAreaNames(basename);
    if (!available.includes(area)) {
      throw new Error(
        `Unknown product area: ${selection}. Available: ${available.join(", ")}.`,
      );
    }
    return {
      name: `${basename}/areas/${area}`,
      directory: path.join(root, basename, "areas", area),
    };
  }
  return { name: basename, directory: path.join(root, basename) };
}

export async function selectAppFixtures(requestedNames: string[] = []) {
  let names = await expandAppFixtureNames(requestedNames);
  if (!names.length)
    names = await selectFixtureNames(OSS_FIXTURES_DIRECTORY, []);
  const fixtures = await Promise.all(
    [...new Set(names)].map(resolveAppFixture),
  );
  const seenNames = new Set<string>();
  return fixtures.filter(({ name }) => {
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });
}

export async function listAppFixtureNames() {
  return expandAppFixtureNames(["oss"]);
}

export async function expandAppFixtureNames(requestedNames: string[]) {
  const selections = await Promise.all(
    requestedNames.map(async (name) => {
      if (name === "oss-areas") {
        const apps = await selectFixtureNames(OSS_FIXTURES_DIRECTORY, []);
        return (
          await Promise.all(
            apps.map(async (app) =>
              (await productAreaNames(app)).map(
                (area) => `oss/${app}/areas/${area}`,
              ),
            ),
          )
        ).flat();
      }
      const areaSelection = /^(?:oss\/)?([\w-]+)\/areas$/.exec(name);
      if (areaSelection) {
        await selectFixtureNames(OSS_FIXTURES_DIRECTORY, [areaSelection[1]]);
        return (await productAreaNames(areaSelection[1])).map(
          (area) => `oss/${areaSelection[1]}/areas/${area}`,
        );
      }
      return name === "oss"
        ? selectFixtureNames(OSS_FIXTURES_DIRECTORY, [])
        : [name];
    }),
  );
  return selections.flat();
}

async function productAreaNames(app: string) {
  const directory = path.join(OSS_FIXTURES_DIRECTORY, app, "areas");
  const names = await selectFixtureNames(directory, []).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  });
  return names.filter((name) => name !== "other");
}

export async function selectBenchmarkFixtures({
  requestedNames = [],
  filterFixture,
}: {
  requestedNames?: string[];
  filterFixture?: (directory: string) => Promise<boolean>;
} = {}): Promise<Fixture[]> {
  const selected = await selectAppFixtures(requestedNames);
  const fixtures = await Promise.all(
    selected.map(async ({ name, directory }): Promise<Fixture | null> => {
      if (filterFixture && !(await filterFixture(directory))) {
        // Caller-supplied selection policy can omit recipes before they are loaded.
        return null;
      }
      return loadAppDeployment(name, directory);
    }),
  );
  return fixtures.filter((fixture) => fixture !== null);
}

async function readRecipe(
  directory: string,
  ancestors: string[] = [],
): Promise<{
  manifest: z.infer<typeof FixtureSchema>;
  layers: DeploymentLayer[];
}> {
  directory = path.resolve(directory);
  if (ancestors.includes(directory))
    throw new Error(`Cyclic fixture inheritance: ${directory}`);
  const { extends: parent, ...recipe } = FixtureRecipeSchema.parse(
    JSON.parse(await readFile(path.join(directory, "fixture.json"), "utf8")),
  );
  const layers: DeploymentLayer[] = [];
  let inherited: z.infer<typeof FixtureRecipeSchema> = {};
  if (parent) {
    const base = await readRecipe(path.resolve(directory, parent), [
      ...ancestors,
      directory,
    ]);
    inherited = base.manifest;
    layers.push(...base.layers);
  }
  layers.push({ directory, files: await discoverDeploymentFiles(directory) });
  return {
    manifest: FixtureSchema.parse({
      ...inherited,
      ...recipe,
      runtimeEnvironment: {
        ...inherited.runtimeEnvironment,
        ...recipe.runtimeEnvironment,
      },
    }),
    layers,
  };
}

export async function loadAppDeployment(
  name: string,
  directory: string,
): Promise<Fixture> {
  directory = path.resolve(directory);
  const { manifest, layers } = await readRecipe(directory);
  let fullAppGroundTruthFile: string | undefined;
  if (manifest.productArea) {
    fullAppGroundTruthFile = path.resolve(directory, "../../ground-truth.json");
  }
  return {
    ...manifest,
    type: "full-app",
    name,
    directory,
    groundTruthFile: path.join(directory, "ground-truth.json"),
    fullAppGroundTruthFile,
    deployment: resolveDeployment(layers),
  };
}

export async function selectFixtureNames(
  root: string,
  requestedNames: string[],
) {
  const availableNames = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unknownNames = requestedNames.filter(
    (name) => !availableNames.includes(name),
  );
  if (unknownNames.length > 0) {
    throw new Error(
      `Unknown fixture(s): ${unknownNames.join(", ")}. Available: ${availableNames.join(", ")}.`,
    );
  }
  if (requestedNames.length) return [...new Set(requestedNames)];
  return availableNames;
}

export async function discoverDeploymentFiles(directory: string) {
  const { stdout } = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd: directory },
  );
  const files = [...new Set(stdout.split("\0").filter(Boolean))]
    .filter((file) => {
      const name = path.posix.basename(file);
      return (
        name !== "ground-truth.json" &&
        name !== "known-invalid.json" &&
        name !== "candidate-findings.json" &&
        name !== "case.json" &&
        !name.endsWith("cases.ts") &&
        !["source", "runs", "reports", "areas"].includes(file.split("/")[0])
      );
    })
    .sort();
  const existingFiles: string[] = [];
  for (const file of files) {
    const entry = await lstat(path.join(directory, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          // Git still lists tracked recipes removed by an uncommitted edit.
          return null;
        }
        throw error;
      },
    );
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      // Recipes upload real files only; linked assets could escape the fixture directory.
      throw new Error(`Unsupported fixture recipe entry: ${file}`);
    }
    existingFiles.push(file);
  }
  return existingFiles;
}

export function selectRuntimeScript(
  files: { target: string }[],
  script: string,
) {
  return (
    files.find((file) => file.target === `case/${script}`) ??
    files.find((file) => file.target === `app/${script}`)
  )?.target;
}
