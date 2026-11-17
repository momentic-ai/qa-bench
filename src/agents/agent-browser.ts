import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { writeJson } from "../shared/json-file";
import { startBrowserbaseRelay } from "./browserbase-relay";

const require = createRequire(import.meta.url);
const command = require.resolve("agent-browser/bin/agent-browser.js");
const packageDirectory = path.dirname(path.dirname(command));
const exec = promisify(execFile);

export type BrowserTool = "playwright-mcp" | "agent-browser" | "e2e";

export async function prepareAgentBrowser(
  workspace: string,
  browser: { args: string[]; env: Record<string, string> },
  skillOwner: ".agents" | ".claude",
) {
  const bin = path.join(workspace, "bin");
  const sockets = path.join(workspace, ".browser-sockets");
  const screenshots = path.join(workspace, "browser-artifacts");
  await Promise.all([mkdir(bin), mkdir(sockets), mkdir(screenshots)]);
  await symlink(command, path.join(bin, "agent-browser"));
  const skills = path.join(workspace, skillOwner, "skills/agent-browser");
  await mkdir(skills, { recursive: true });
  await copyFile(
    path.join(packageDirectory, "skills/agent-browser/SKILL.md"),
    path.join(skills, "SKILL.md"),
  );
  const config = path.join(workspace, "agent-browser.json");
  const supervisor = browser.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  const relay = supervisor
    ? await startBrowserbaseRelay(supervisor)
    : undefined;
  const executableIndex = browser.args.indexOf("--executable-path");
  await writeJson(
    config,
    relay
      ? { cdp: String(relay.port) }
      : { executablePath: browser.args[executableIndex + 1] },
  );
  return {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      AGENT_BROWSER_CONFIG: config,
      AGENT_BROWSER_SOCKET_DIR: sockets,
      AGENT_BROWSER_SCREENSHOT_DIR: screenshots,
    },
    close: () => relay?.close(),
  };
}

export async function closeAgentBrowsers(
  env: Record<string, string>,
  artifactDirectory: string,
) {
  try {
    await exec(process.execPath, [command, "close", "--all"], {
      env: { HOME: process.env.HOME, ...env },
      timeout: 30_000,
    });
  } finally {
    const workspace = path.dirname(env.AGENT_BROWSER_CONFIG);
    await cp(workspace, artifactDirectory, {
      recursive: true,
      filter: (entry) =>
        ![
          "bin",
          ".agents",
          ".claude",
          ".browser-sockets",
          "agent-browser.json",
        ].includes(path.relative(workspace, entry).split(path.sep)[0]),
    });
  }
}

export async function validateAgentBrowser() {
  await exec(process.execPath, [command, "--version"], { timeout: 10_000 });
}
