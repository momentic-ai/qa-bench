import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentContext,
  Browser,
  CODEX_MODELS,
  CodexModel,
  EvalAgentDefinition,
} from "../../evals/agent";
import {
  BrowserTool,
  closeAgentBrowsers,
  prepareAgentBrowser,
  validateAgentBrowser,
} from "../agent-browser";
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
  protected skillOwner: ".agents" | ".claude" = ".agents";
  private browsers: BrowserbaseSessions | undefined;
  private browserTemporaryDirectory: string | undefined;
  private browserEnvironment: Record<string, string> | undefined;

  constructor(
    context: AgentContext,
    protected browserTool: BrowserTool = "playwright-mcp",
    model: string = CODEX_MODELS[0],
  ) {
    super(context, model);
  }

  protected async prepare() {
    if (this.browserTool === "agent-browser") {
      if (!this.temporaryWorkspace)
        throw new Error("Agent workspace is missing.");
      this.browserEnvironment = await prepareAgentBrowser(
        this.temporaryWorkspace,
        await this.connectBrowser(),
        this.skillOwner,
      );
      return {
        mcpServers: {},
        env: this.browserEnvironment,
        sandbox: "workspace-write" as const,
      };
    }
    return {
      mcpServers: await this.prepareBrowserMcp(),
      subagents: !this.localBrowser,
    };
  }

  protected async collectBrowserCost() {
    return this.browsers?.cost();
  }

  protected async cleanup() {
    try {
      if (this.browserEnvironment)
        await closeAgentBrowsers(
          this.browserEnvironment,
          path.join(this.context.runDirectory, "browser-artifacts"),
        );
    } finally {
      await this.browsers?.stop();
    }
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

export function codexAgent(
  browser: Browser,
  browserTool: BrowserTool = "playwright-mcp",
  model: CodexModel = CODEX_MODELS[0],
): EvalAgentDefinition {
  return {
    name: `codex-${browserTool}`,
    reportSubdirectory: `codex-${browserTool}`,
    concurrency: browser === "local" ? 2 : Infinity,
    config: {
      model,
      browser,
      ...(browserTool === "playwright-mcp"
        ? { subagents: browser !== "local" }
        : {}),
    },
    async validateEnvironment() {
      if (!process.env.OPENAI_API_KEY)
        throw new Error("OPENAI_API_KEY is required.");
      if (browserTool === "agent-browser") await validateAgentBrowser();
      if (browser === "local") await validateLocalChromium();
      else if (!process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required.");
    },
    create(context) {
      return browser === "local"
        ? new LocalCodexAgent(context, browserTool, model)
        : new CodexAgent(context, browserTool, model);
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
