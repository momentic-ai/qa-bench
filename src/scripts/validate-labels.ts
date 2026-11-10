import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { GroundTruthSchema, KnownInvalidSchema } from "../evals/reports";

const schemas = {
  "ground-truth.json": GroundTruthSchema,
  "known-invalid.json": KnownInvalidSchema,
};
const root = path.resolve(import.meta.dirname, "../../fixtures/web/oss");
const labelFile = /^[^/]+\/areas\/[^/]+\/(ground-truth|known-invalid)\.json$/;
const files = (await readdir(root, { recursive: true }))
  .filter((file) => labelFile.test(file.split(path.sep).join("/")))
  .map((file) => path.join(root, file))
  .sort();
if (!files.length) throw new Error(`No label files found in ${root}.`);

let invalid = 0;
for (const file of files) {
  const schema = schemas[path.basename(file) as keyof typeof schemas];
  const result = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (result.success) continue;
  invalid++;
  for (const issue of result.error.issues) {
    process.stderr.write(
      `${file}: ${issue.path.join(".")}: ${issue.message}\n`,
    );
  }
}
process.stdout.write(
  `Validated ${files.length} label files; ${invalid} invalid.\n`,
);
if (invalid) process.exitCode = 1;
