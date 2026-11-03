import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import {
  AgentBrowserProvider,
  AgentBrowserSessions,
} from "./agent-browser-sessions";

const require = createRequire(import.meta.url);
const command = require.resolve("agent-browser/bin/agent-browser.js");
const packageDirectory = path.dirname(path.dirname(command));
const exec = promisify(execFile);

export type BrowserTool = "playwright-mcp" | "agent-browser";

export async function prepareAgentBrowser(
  workspace: string,
  browser: { args: string[]; env: Record<string, string> },
  skillOwner: ".agents" | ".claude",
  reportDirectory: string,
  provider?: AgentBrowserProvider,
) {
  const bin = path.join(workspace, "bin");
  await mkdir(bin);
  await symlink(
    path.join(import.meta.dirname, "agent-browser-wrapper.mjs"),
    path.join(bin, "agent-browser"),
  );
  const skills = path.join(workspace, skillOwner, "skills/agent-browser");
  await mkdir(skills, { recursive: true });
  await copyFile(
    path.join(packageDirectory, "skills/agent-browser/SKILL.md"),
    path.join(skills, "SKILL.md"),
  );
  const executableIndex = browser.args.indexOf("--executable-path");
  if (!provider && executableIndex < 0)
    throw new Error("Missing owned browser provider.");
  const sessions = new AgentBrowserSessions(
    workspace,
    command,
    reportDirectory,
    provider,
    executableIndex < 0 ? undefined : browser.args[executableIndex + 1],
  );
  const endpoint = await sessions.start();
  return {
    workspace,
    sessions,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      QA_BENCH_BROWSER_BROKER: endpoint,
    },
  };
}

export async function closeAgentBrowsers(
  runtime: Awaited<ReturnType<typeof prepareAgentBrowser>>,
  artifactDirectory: string,
) {
  try {
    await runtime.sessions.close();
  } finally {
    const workspace = runtime.workspace;
    await cp(workspace, artifactDirectory, {
      recursive: true,
      filter: (entry) =>
        ![
          "bin",
          ".agents",
          ".claude",
          ".browser-sockets",
          "agent-browser.json",
          ".browser-owners",
        ].includes(path.relative(workspace, entry).split(path.sep)[0]),
    });
  }
}

export async function validateAgentBrowser() {
  await exec(process.execPath, [command, "--version"], { timeout: 10_000 });
  // The pinned recorder uses -fps_mode, which FFmpeg 4 rejects after recording starts.
  for (const encoder of ["libvpx", "libx264"]) {
    try {
      await exec(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=s=16x16:r=1",
          "-frames:v",
          "1",
          "-fps_mode",
          "vfr",
          "-c:v",
          encoder,
          "-f",
          "null",
          "-",
        ],
        { timeout: 10_000 },
      );
    } catch {
      throw new Error(
        "agent-browser recording needs FFmpeg on PATH with -fps_mode support, libvpx, and libx264. Upgrade FFmpeg before running evals; the recorder encoder preflight failed.",
      );
    }
  }
}
