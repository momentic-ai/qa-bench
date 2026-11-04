import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentContext, Browser } from "../evals/agent";
import { combinedCost } from "../evals/browser-cost";
import { AgentCost } from "../evals/cost";
import {
  BrowserTool,
  closeAgentBrowsers,
  prepareAgentBrowser,
  validateAgentBrowser,
} from "./agent-browser";
import { BrowserbaseSessions } from "./codex/browserbase";
import { localBrowserConnection, validateLocalChromium } from "./local-browser";

const require = createRequire(import.meta.url);
export const DISABLED_BROWSER_TOOL = "browser_run_code_unsafe";
// Sites holding upstream issues, fixes or this benchmark's labels, copies of them,
// and search engines that lead to them. Playwright matches a bare host exactly, so
// each domain also gets a `*.` pattern; `*` spans dots, so `google.*` covers google.co.uk.
const ANSWER_DOMAINS = [
  // Code hosts, plus GitHub viewers, mirrors and raw-file proxies
  "github.com",
  "githubusercontent.com",
  "github.dev",
  "github1s.com",
  "githubbox.com",
  "githack.com",
  "statically.io",
  "gitlab.com",
  "codeberg.org",
  "gitea.com",
  "bitbucket.org",
  "gitee.com",
  // Code search and AI repository readers
  "sourcegraph.com",
  "grep.app",
  "deepwiki.com",
  "gitingest.com",
  "uithub.com",
  // The published dataset, its mirrors and dataset hubs, and Mo sessions linked from labels
  "huggingface.co",
  "hf.co",
  "hf-mirror.com",
  "modelscope.cn",
  "modelscope.ai",
  "wisemodel.cn",
  "gitcode.com",
  "opendatalab.com",
  "kaggle.com",
  "paperswithcode.com",
  "app.momentic.ai",
  // Upstream forums
  "discourse.metabase.com",
  "forum.gitea.com",
  // Archives and translation proxies that serve copies of blocked pages
  "archive.org",
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.li",
  "archive.md",
  "translate.goog",
  // Search and AI answer engines
  "google.*",
  "bing.com",
  "duckduckgo.com",
  "duck.com",
  "duck.ai",
  "search.yahoo.*",
  "yandex.*",
  "ya.ru",
  "baidu.com",
  "naver.com",
  "seznam.cz",
  "so.com",
  "sogou.com",
  "search.aol.com",
  "ask.com",
  "swisscows.com",
  "metager.org",
  "presearch.com",
  "yep.com",
  "ecosia.org",
  "startpage.com",
  "qwant.com",
  "search.brave.com",
  "kagi.com",
  "mojeek.com",
  "you.com",
  "perplexity.ai",
  "phind.com",
  "chatgpt.com",
  "chat.openai.com",
  "copilot.microsoft.com",
  "claude.ai",
];
// Trailing-dot hostnames (github.com.) reach the same sites, so block those too.
const ANSWER_SOURCES = ANSWER_DOMAINS.flatMap((domain) => [
  domain,
  `*.${domain}`,
  `${domain}.`,
  `*.${domain}.`,
]);

export type BrowserOptions = {
  browser: Browser;
  preventCheating: boolean;
  /** Where the agent discovers skills. */
  skillOwner: ".agents" | ".claude";
};

export type PreparedBrowser = {
  playwright?: {
    command: string;
    cwd: string;
    args: string[];
    env: Record<string, string>;
  };
  env?: Record<string, string>;
  /** agent-browser needs network access and background processes from the shell. */
  unsandboxedShell: boolean;
  subagents?: boolean;
  /** Appended to the task brief. */
  instructions?: string;
};

type BrowserToolSetup = Omit<
  PreparedBrowser,
  "instructions" | "unsandboxedShell"
>;

/** One coding-agent run's browser and the tool the agent drives it with. */
export abstract class TestingBrowser {
  readonly artifacts: string;
  protected workspace: string | undefined;
  private browsers: BrowserbaseSessions | undefined;
  protected unsandboxedShell = true;
  /** Whether answer sites are blocked even on a local browser. */
  protected blocksSitesLocally = false;
  protected keepAlive = false;

  constructor(
    protected context: AgentContext,
    readonly options: BrowserOptions,
  ) {
    this.artifacts = path.join(context.runDirectory, "browser-artifacts");
  }

  static for(tool: BrowserTool) {
    return BROWSER_TOOLS[tool];
  }

  static async validate(browser: Browser) {
    if (browser === "local") await validateLocalChromium();
    else if (!process.env.BROWSERBASE_API_KEY)
      throw new Error("BROWSERBASE_API_KEY is required.");
  }

  protected abstract setup(workspace: string): Promise<BrowserToolSetup>;

  async prepare(workspace: string): Promise<PreparedBrowser> {
    const { browser, preventCheating } = this.options;
    this.workspace = workspace;
    const sitesBlocked = this.blocksSitesLocally || browser !== "local";
    const instructions =
      preventCheating && sitesBlocked
        ? "Some external sites are blocked. Record flows that need one as coverage limitations, not bugs."
        : "";
    return {
      instructions,
      unsandboxedShell: this.unsandboxedShell,
      ...(await this.setup(workspace)),
    };
  }

  async cost(
    model: AgentCost | null,
    modelComplete: boolean,
  ): Promise<AgentCost | null> {
    const browser = await this.browsers?.cost();
    return browser
      ? {
          ...model,
          ...combinedCost(model?.estimatedUsd ?? null, modelComplete, browser),
        }
      : // Local browsers have no provider charge, so model cost is the whole cost.
        model && {
          ...model,
          costComplete: this.options.browser === "local" && modelComplete,
        };
  }

  async close() {
    await this.browsers?.stop();
  }

  protected async connect(): Promise<{
    args: string[];
    env: Record<string, string>;
  }> {
    if (this.options.browser === "local") return localBrowserConnection();
    let allowedDomains: string[] | undefined;
    if (this.options.preventCheating) {
      if (!this.context.targetUrl)
        throw new Error("--prevent-cheating needs the fixture URL.");
      allowedDomains = [this.context.targetUrl.hostname];
    }
    this.browsers = new BrowserbaseSessions(
      path.join(this.context.runDirectory, "browser-sessions"),
      process.env.BROWSERBASE_API_KEY || "",
      {
        allowedDomains,
        keepAlive: this.keepAlive,
        timeoutSeconds: Math.min(
          21600,
          Math.ceil((this.context.timeLimitMs ?? 120 * 60_000) / 1000) + 120,
        ),
      },
    );
    return {
      args: [],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: await this.browsers.start() },
    };
  }
}

class PlaywrightMcp extends TestingBrowser {
  protected unsandboxedShell = false;
  protected blocksSitesLocally = true;
  private temporaryDirectory: string | undefined;

  protected async setup() {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pw-eval-"));
    this.temporaryDirectory = temporaryDirectory;
    await mkdir(this.artifacts, { recursive: true });
    const browser = await this.connect();
    return {
      playwright: {
        command: process.execPath,
        cwd: this.artifacts,
        args: [
          path.join(
            path.dirname(require.resolve("@playwright/mcp/package.json")),
            "cli.js",
          ),
          ...browser.args,
          "--output-dir",
          this.artifacts,
          ...(this.options.preventCheating
            ? ["--blocked-origins", ANSWER_SOURCES.join(";")]
            : []),
        ],
        env: { ...browser.env, TMPDIR: temporaryDirectory },
      },
      subagents: this.options.browser !== "local",
    };
  }

  async close() {
    await super.close();
    if (this.temporaryDirectory)
      await rm(this.temporaryDirectory, { recursive: true, force: true });
  }
}

class AgentBrowser extends TestingBrowser {
  // Shared agent-browser sessions must survive disconnects.
  protected keepAlive = true;
  private environment: Record<string, string> | undefined;

  static async validate(browser: Browser) {
    await validateAgentBrowser();
    await super.validate(browser);
  }

  protected async setup(workspace: string) {
    this.environment = await prepareAgentBrowser(
      workspace,
      await this.connect(),
      this.options.skillOwner,
    );
    return { env: this.environment };
  }

  async close() {
    try {
      if (this.environment)
        await closeAgentBrowsers(this.environment, this.artifacts);
    } finally {
      await super.close();
    }
  }
}

const BROWSER_TOOLS = {
  "playwright-mcp": PlaywrightMcp,
  "agent-browser": AgentBrowser,
} satisfies Record<BrowserTool, unknown>;
