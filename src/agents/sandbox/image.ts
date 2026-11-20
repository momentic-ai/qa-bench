import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Everything the image is built from: .dockerignore and the paths it lets in. */
async function sources() {
  const allowed = (
    await readFile(path.join(REPO_ROOT, ".dockerignore"), "utf8")
  )
    .split("\n")
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1));
  const files = [".dockerignore"];
  for (const source of allowed) {
    const full = path.join(REPO_ROOT, source);
    if (!(await stat(full)).isDirectory()) {
      files.push(source);
      continue;
    }
    for (const entry of await readdir(full, {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile())
        files.push(
          path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)),
        );
  }
  return files.sort();
}

let tag: Promise<string> | undefined;

/** Tagged by a hash of its build inputs, so each code version gets its own image. */
export function sandboxImage() {
  tag ??= (async () => {
    const hash = createHash("sha256");
    for (const source of await sources())
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
  const { stdout } = await promisify(execFile)("docker", [
    "info",
    "--format",
    "{{json .SecurityOptions}}",
  ]).catch((err: unknown) => {
    throw new Error(
      `Docker is required for Codex and Claude Code runs: ${err}`,
    );
  });
  // Rootless Docker maps the container's user to a subordinate UID that can't write the run's folders.
  if (stdout.includes("name=rootless"))
    throw new Error("Codex and Claude Code runs need Docker in rootful mode.");
  const image = await sandboxImage();
  if ((await docker(["image", "inspect", image], "ignore")) === 0) return;
  process.stderr.write(`Building ${image}; this happens once per change.\n`);
  const code = await docker(
    ["build", "--file", "sandbox/Dockerfile", "--tag", image, "."],
    "inherit",
  ).catch((err: unknown) => {
    throw new Error(
      `Docker is required for Codex and Claude Code runs: ${err}`,
    );
  });
  if (code !== 0) throw new Error(`Building ${image} failed.`);
}
