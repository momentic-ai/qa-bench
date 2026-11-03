import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { writeJson } from "../evals/json-file";

const require = createRequire(import.meta.url);
const command = require.resolve("agent-browser/bin/agent-browser.js");
const packageDirectory = path.dirname(path.dirname(command));
const exec = promisify(execFile);
const wrapper = path.join(import.meta.dirname, "agent-browser-wrapper.mjs");

export type BrowserTool = "playwright-mcp" | "agent-browser";

export async function prepareAgentBrowser(
  workspace: string,
  browser: { args: string[]; env: Record<string, string> },
  skillOwner: ".agents" | ".claude",
) {
  const bin = path.join(workspace, "bin");
  const sockets = await mkdtemp(path.join(tmpdir(), "qa-bs-"));
  const screenshots = path.join(workspace, "browser-artifacts");
  await Promise.all([mkdir(bin), mkdir(screenshots)]);
  await symlink(wrapper, path.join(bin, "agent-browser"));
  const skills = path.join(workspace, skillOwner, "skills/agent-browser");
  await mkdir(skills, { recursive: true });
  await copyFile(
    path.join(packageDirectory, "skills/agent-browser/SKILL.md"),
    path.join(skills, "SKILL.md"),
  );
  const config = path.join(workspace, "agent-browser.json");
  const executableIndex = browser.args.indexOf("--executable-path");
  const cdp = browser.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
  await writeJson(
    config,
    cdp ? {} : { executablePath: browser.args[executableIndex + 1] },
  );
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    AGENT_BROWSER_CONFIG: config,
    QA_BENCH_BROWSER_COMMAND: command,
    ...(cdp
      ? {
          QA_BENCH_CDP_ENDPOINT: cdp,
          AGENT_BROWSER_PROVIDER: "qa-bench-browserbase",
          AGENT_BROWSER_PLUGINS: JSON.stringify([
            {
              name: "qa-bench-browserbase",
              command: process.execPath,
              args: [
                path.join(import.meta.dirname, "browserbase-provider.mjs"),
              ],
              capabilities: ["browser.provider"],
            },
          ]),
        }
      : {}),
    AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_SCREENSHOT_DIR: screenshots,
  };
}

export async function closeAgentBrowser(
  env: Record<string, string>,
  agentId: string,
) {
  await exec(process.execPath, [wrapper, "close", "--all"], {
    env: { HOME: process.env.HOME, ...env, QA_BENCH_BROWSER_AGENT_ID: agentId },
    timeout: 30_000,
  });
}

export async function closeAgentBrowsers(
  env: Record<string, string>,
  artifactDirectory: string,
) {
  try {
    const owners = await readdir(env.AGENT_BROWSER_SOCKET_DIR);
    const results = await Promise.allSettled(
      owners.map((namespace) =>
        exec(process.execPath, [command, "close", "--all"], {
          env: {
            HOME: process.env.HOME,
            ...env,
            AGENT_BROWSER_NAMESPACE: namespace,
            AGENT_BROWSER_SOCKET_DIR: path.join(
              env.AGENT_BROWSER_SOCKET_DIR,
              namespace,
            ),
          },
          timeout: 30_000,
        }),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    await rm(env.AGENT_BROWSER_SOCKET_DIR, { recursive: true, force: true });
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
