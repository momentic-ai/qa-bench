import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { EvalAgentDefinition } from "../../evals/agent";
import { BrowserbaseSessions } from "./browserbase";
import { CodexRunner } from "./codex-runner";

const packageDirectory = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);

type BrowserConnection = {
  args: string[];
  env: Record<string, string>;
  filesystem: Record<string, string>;
};

export class CodexAgent extends CodexRunner {
  private browsers: BrowserbaseSessions | undefined;
  private browserTemporaryDirectory: string | undefined;

  protected async prepare(
    _workspace: string,
    resolverFiles: Record<string, string>,
  ) {
    return {
      mcpServers: await this.prepareBrowserMcp(resolverFiles),
      subagents: false,
      filesystem: {
        [path.join(this.context.runDirectory, "browser-artifacts")]: "read",
      },
      instructions: "",
    };
  }

  protected async collectBrowserCost() {
    return this.browsers?.cost();
  }

  protected async cleanup() {
    await this.browsers?.stop();
    if (this.browserTemporaryDirectory) {
      await rm(this.browserTemporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  protected async connectBrowser(): Promise<BrowserConnection> {
    this.browsers = new BrowserbaseSessions(
      path.join(this.context.runDirectory, "browser-sessions"),
      process.env.BROWSERBASE_API_KEY || "",
    );
    return {
      args: [],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: await this.browsers.start() },
      filesystem: {},
    };
  }

  private async prepareBrowserMcp(resolverFiles: Record<string, string>) {
    // Deep workspace paths exceed Unix socket limits; mount a short, run-owned temporary directory.
    const browserTemporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pw-eval-"),
    );
    this.browserTemporaryDirectory = browserTemporaryDirectory;
    const browserOutputDirectory = path.join(
      this.context.runDirectory,
      "browser-artifacts",
    );
    await mkdir(browserOutputDirectory, { recursive: true });
    const nodeExecutable = await realpath(process.execPath);
    const nodeModulesDirectory = await realpath(
      path.join(packageDirectory, "node_modules"),
    );
    const playwrightConfig = path.join(
      packageDirectory,
      "playwright-config.json",
    );
    const browser = await this.connectBrowser();
    const playwrightCommand = path.join(
      path.dirname(require.resolve("@playwright/mcp/package.json")),
      "cli.js",
    );
    const browserPermissions = `permissions.browser={filesystem={${Object.entries(
      {
        ":minimal": "read",
        ":workspace_roots": "read",
        [browserOutputDirectory]: "write",
        [browserTemporaryDirectory]: "write",
        [path.join(this.codexHome, "tmp", "arg0")]: "read",
        [nodeExecutable]: "read",
        [nodeModulesDirectory]: "read",
        ...resolverFiles,
        [playwrightConfig]: "read",
        ...browser.filesystem,
      },
    )
      .map(
        ([file, permission]) =>
          `${JSON.stringify(file)}=${JSON.stringify(permission)}`,
      )
      .join(",")}},network={enabled=true}}`;
    return {
      playwright: {
        command: process.execPath,
        cwd: browserOutputDirectory,
        args: [
          // MCP runs outside Codex's shell sandbox; give it its own filesystem boundary.
          this.command,
          "sandbox",
          "--permission-profile",
          "browser",
          "--cd",
          browserOutputDirectory,
          "-c",
          browserPermissions,
          "--",
          nodeExecutable,
          playwrightCommand,
          "--config",
          playwrightConfig,
          ...browser.args,
          "--output-dir",
          browserOutputDirectory,
        ],
        env: { ...browser.env, TMPDIR: browserTemporaryDirectory },
        startup_timeout_sec: 60,
        tool_timeout_sec: 120,
        default_tools_approval_mode: "approve",
        required: true,
        disabled_tools: ["browser_run_code_unsafe"],
      },
    };
  }
}

export const codexAgent: EvalAgentDefinition = {
  name: "Codex",
  reportSubdirectory: "codex",
  concurrency: Infinity,
  validateEnvironment() {
    for (const name of ["OPENAI_API_KEY", "BROWSERBASE_API_KEY"]) {
      if (!process.env[name]) throw new Error(`${name} is required.`);
    }
  },
  create(context) {
    return new CodexAgent(context);
  },
};
