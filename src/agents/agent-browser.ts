import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { writeJson } from "../evals/json-file";
import { ToolRuntime } from "../sandbox/runtime";

const require = createRequire(import.meta.url);
const command = require.resolve("agent-browser/bin/agent-browser.js");
const packageDirectory = path.dirname(path.dirname(command));
const exec = promisify(execFile);

export type BrowserTool = "playwright-mcp" | "agent-browser" | "e2e";

export async function prepareAgentBrowser(
  workspace: string,
  browser: { args: string[]; env: Record<string, string> },
  skillOwner: ".agents" | ".claude",
  runtime: ToolRuntime,
) {
  const bin = path.join(workspace, "bin");
  const sockets = path.join(workspace, ".browser-sockets");
  const screenshots = path.join(workspace, "browser-artifacts");
  await Promise.all([mkdir(bin), mkdir(sockets), mkdir(screenshots)]);
  await symlink(runtime.path(command), path.join(bin, "agent-browser"));
  const skills = path.join(workspace, skillOwner, "skills/agent-browser");
  await mkdir(skills, { recursive: true });
  await copyFile(
    path.join(packageDirectory, "skills/agent-browser/SKILL.md"),
    path.join(skills, "SKILL.md"),
  );
  const config = path.join(workspace, "agent-browser.json");
  const executableIndex = browser.args.indexOf("--executable-path");
  let cdp: string | undefined;
  if (browser.env.PLAYWRIGHT_MCP_CDP_ENDPOINT) {
    const response = await fetch(
      new URL("json/version/", browser.env.PLAYWRIGHT_MCP_CDP_ENDPOINT),
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(`Browser connection failed: HTTP ${response.status}`);
    cdp = z
      .object({ webSocketDebuggerUrl: z.url() })
      .parse(await response.json()).webSocketDebuggerUrl;
  }
  await writeJson(config, {
    ...(cdp ? { cdp } : { executablePath: browser.args[executableIndex + 1] }),
  });
  return {
    PATH: runtime.pathEnv([bin]),
    AGENT_BROWSER_CONFIG: config,
    AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_SCREENSHOT_DIR: screenshots,
  };
}

export async function closeAgentBrowsers(
  env: Record<string, string>,
  artifactDirectory: string,
  runtime: ToolRuntime,
) {
  try {
    await runtime.run(runtime.node, [runtime.path(command), "close", "--all"], {
      env: { HOME: process.env.HOME, ...env },
      timeoutMs: 30_000,
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
