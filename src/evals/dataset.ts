import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const PRODUCT_AREAS_DIRECTORY = "areas";
const DatasetSchema = z.object({
  bugs: z.array(z.object({ name: z.string() }).passthrough()),
});

// A single reproSteps list and a one-case list of lists are the same label.
function asCases(bug: Record<string, unknown>) {
  const steps = bug.reproSteps;
  if (!Array.isArray(steps) || steps.some((step) => Array.isArray(step)))
    return bug;
  return { ...bug, reproSteps: [steps] };
}

export async function readDataset(file: string): Promise<string> {
  const areas = path.join(path.dirname(file), PRODUCT_AREAS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(areas, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return readFile(file, "utf8");
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(areas, entry.name, path.basename(file)))
    .sort();
  if (!files.length) throw new Error(`No area datasets found in ${areas}.`);
  const datasets = await Promise.all(
    files.map(async (areaFile) => {
      try {
        return DatasetSchema.parse(JSON.parse(await readFile(areaFile, "utf8")))
          .bugs;
      } catch (error) {
        throw new Error(`Cannot load area dataset ${areaFile}.`, {
          cause: error,
        });
      }
    }),
  );
  // Only ground-truth labels take reproSteps cases; known-invalid entries keep a single list.
  const normalize =
    path.basename(file) === "ground-truth.json"
      ? asCases
      : (bug: Record<string, unknown>) => bug;
  const combined = new Map<string, (typeof datasets)[number][number]>();
  for (const bug of datasets.flat().map(normalize)) {
    const previous = combined.get(bug.name as string);
    if (previous && !isDeepStrictEqual(previous, bug)) {
      throw new Error(`Conflicting labels for ${bug.name} in ${file}.`);
    }
    combined.set(bug.name as string, bug as (typeof datasets)[number][number]);
  }
  return JSON.stringify({ bugs: [...combined.values()] }) + "\n";
}
