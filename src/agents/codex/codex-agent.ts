import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { Browser, EvalAgentDefinition } from "../../evals/agent";
import {
  localBrowserConnection,
  validateLocalChromium,
} from "../local-browser";
import { BrowserbaseSessions } from "./browserbase";
import { CodexRunner } from "./codex-runner";

const require = createRequire(import.meta.url);

type BrowserConnection = {
  args: string[];
  env: Record<string, string>;
};

export class CodexAgent extends CodexRunner {
  protected localBrowser = false;
  private browsers: BrowserbaseSessions | undefined;
  private browserTemporaryDirectory: string | undefined;

  protected async prepare() {
    return {
      mcpServers: await this.prepareBrowserMcp(),
      subagents: !this.localBrowser,
    };
  }

  protected async collectBrowserCost() {
    return this.browsers?.cost();
  }

  protected async cleanup() {
    await this.browsers?.stop();
    if (this.temporaryWorkspace)
      await rm(this.temporaryWorkspace, { recursive: true, force: true });
    if (this.browserTemporaryDirectory) {
      await rm(this.browserTemporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  protected async connectBrowser(): Promise<BrowserConnection> {
    if (this.localBrowser) return localBrowserConnection();
    this.browsers = new BrowserbaseSessions(
      path.join(this.context.runDirectory, "browser-sessions"),
      process.env.BROWSERBASE_API_KEY || "",
    );
    return {
      args: [],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: await this.browsers.start() },
    };
  }

  private async prepareBrowserMcp() {
    const browserTemporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pw-eval-"),
    );
    this.browserTemporaryDirectory = browserTemporaryDirectory;
    const browserOutputDirectory = path.join(
      this.context.runDirectory,
      "browser-artifacts",
    );
    await mkdir(browserOutputDirectory, { recursive: true });
    const browser = await this.connectBrowser();
    const playwrightCommand = path.join(
      path.dirname(require.resolve("@playwright/mcp/package.json")),
      "cli.js",
    );
    return {
      playwright: {
        command: process.execPath,
        cwd: browserOutputDirectory,
        args: [
          playwrightCommand,
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

export function codexAgent(browser: Browser): EvalAgentDefinition {
  return {
    name: "codex-playwright-mcp",
    reportSubdirectory: "codex-playwright-mcp",
    concurrency: browser === "local" ? 2 : Infinity,
    config: { browser, subagents: browser !== "local" },
    async validateEnvironment() {
      if (!process.env.OPENAI_API_KEY)
        throw new Error("OPENAI_API_KEY is required.");
      if (browser === "local") await validateLocalChromium();
      else if (!process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required.");
    },
    create(context) {
      return browser === "local"
        ? new LocalCodexAgent(context)
        : new CodexAgent(context);
    },
  };
}

class LocalCodexAgent extends CodexAgent {
  protected localBrowser = true;

  protected async collectCost() {
    const cost = await super.collectCost();
    // Local browsers have no provider charge, so model cost is the whole cost.
    return cost && { ...cost, costComplete: true };
  }
}
