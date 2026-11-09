import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
// Everything the image is built from; changing any of it names a new image.
const SOURCES = [
  "sandbox/Dockerfile",
  "sandbox/relay.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "src/agents/e2e/config.ts",
];

let tag: Promise<string> | undefined;

/** The sandbox image built from this checkout's sources. */
export function sandboxImage() {
  tag ??= (async () => {
    const hash = createHash("sha256");
    for (const source of SOURCES)
      hash.update(source).update(await readFile(path.join(REPO_ROOT, source)));
    return `qa-bench-sandbox:${hash.digest("hex").slice(0, 16)}`;
  })();
  return tag;
}

function docker(args: string[], stdio: "ignore" | "inherit") {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", stdio, stdio],
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

/** Builds the sandbox image if this checkout's version of it doesn't exist yet. */
export async function ensureSandboxImage() {
  const image = await sandboxImage();
  if ((await docker(["image", "inspect", image], "ignore")) === 0) return;
  process.stderr.write(
    `Building ${image}; this happens once per tool change.\n`,
  );
  const code = await docker(
    ["build", "--file", "sandbox/Dockerfile", "--tag", image, "."],
    "inherit",
  ).catch((err: unknown) => {
    throw new Error(`Docker is required for sandboxed runs: ${err}`);
  });
  if (code !== 0) throw new Error(`Building ${image} failed.`);
}
