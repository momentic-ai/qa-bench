import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { AgentContext, Browser } from "../evals/agent";
import { combinedCost } from "../evals/browser-cost";
import { AgentCost } from "../evals/cost";
import { ToolRuntime } from "../sandbox/runtime";
import {
  BrowserTool,
  closeAgentBrowsers,
  prepareAgentBrowser,
  validateAgentBrowser,
} from "./agent-browser";
import { BrowserbaseSessions } from "./codex/browserbase";
import { E2EModel } from "./e2e/config";
import {
  addE2ECost,
  e2eInstructions,
  prepareE2E,
  validateE2E,
} from "./e2e/workspace";
import { validateLocalChromium } from "./local-browser";

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
  e2eModel: E2EModel;
};

export type PreparedBrowser = {
  playwright?: {
    command: string;
    cwd: string;
    args: string[];
    env: Record<string, string>;
  };
  env?: Record<string, string>;
  subagents?: boolean;
  /** Appended to the task brief. */
  instructions?: string;
};

type BrowserToolSetup = Omit<PreparedBrowser, "instructions">;

/** One coding-agent run's browser and the tool the agent drives it with. */
export abstract class TestingBrowser {
  readonly artifacts: string;
  private browsers: BrowserbaseSessions | undefined;
  protected runtime!: ToolRuntime;
  /** Whether answer sites are blocked even on a local browser. */
  protected blocksSitesLocally = false;
  protected keepAlive = false;
  protected instructions: string | undefined;

  constructor(
    protected context: AgentContext,
    readonly options: BrowserOptions,
  ) {
    this.artifacts = path.join(context.runDirectory, "browser-artifacts");
  }

  static for(tool: BrowserTool) {
    return BROWSER_TOOLS[tool];
  }

  /** Checks what runs on the host; a sandboxed run's tools come with its image. */
  static async validate(browser: Browser, sandboxed: boolean) {
    if (browser !== "local") {
      if (!process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required.");
    } else if (!sandboxed) await validateLocalChromium();
  }

  protected abstract setup(workspace: string): Promise<BrowserToolSetup>;

  async prepare(
    workspace: string,
    runtime: ToolRuntime,
  ): Promise<PreparedBrowser> {
    this.runtime = runtime;
    const setup = await this.setup(workspace);
    const { browser, preventCheating } = this.options;
    const sitesBlocked = this.blocksSitesLocally || browser !== "local";
    const instructions = [
      this.instructions,
      preventCheating &&
        sitesBlocked &&
        "Some external sites are blocked. Record flows that need one as coverage limitations, not bugs.",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { instructions, ...setup };
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
    if (this.options.browser === "local")
      return {
        args: [
          "--browser",
          "chromium",
          "--headless",
          "--executable-path",
          await this.runtime.chromium(),
        ],
        env: {},
      };
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
    const endpoint = await this.browsers.start();
    await this.runtime.forward(Number(new URL(endpoint).port));
    return { args: [], env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint } };
  }
}

class PlaywrightMcp extends TestingBrowser {
  protected blocksSitesLocally = true;

  protected async setup() {
    const temporaryDirectory = await this.runtime.temporaryDirectory();
    await mkdir(this.artifacts, { recursive: true });
    const browser = await this.connect();
    return {
      playwright: {
        command: this.runtime.node,
        cwd: this.artifacts,
        args: [
          this.runtime.path(
            path.join(
              path.dirname(require.resolve("@playwright/mcp/package.json")),
              "cli.js",
            ),
          ),
          ...browser.args,
          ...(this.options.browser === "local" && this.runtime.browserProxy
            ? ["--proxy-server", this.runtime.browserProxy]
            : []),
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
}

class AgentBrowser extends TestingBrowser {
  // Shared agent-browser sessions must survive disconnects.
  protected keepAlive = true;
  private environment: Record<string, string> | undefined;

  static async validate(browser: Browser, sandboxed: boolean) {
    if (!sandboxed) await validateAgentBrowser();
    await super.validate(browser, sandboxed);
  }

  protected async setup(workspace: string) {
    this.environment = await prepareAgentBrowser(
      workspace,
      await this.connect(),
      this.options.skillOwner,
      this.runtime,
    );
    return { env: this.environment };
  }

  async close() {
    try {
      if (this.environment)
        await closeAgentBrowsers(
          this.environment,
          this.artifacts,
          this.runtime,
        );
    } finally {
      await super.close();
    }
  }
}

class E2E extends TestingBrowser {
  private journal: string | undefined;
  private workspace: string | undefined;

  static async validate(browser: Browser, sandboxed: boolean) {
    if (!sandboxed) await validateE2E();
    // e2e downloads its own pinned Chromium.
    if (browser !== "local") await super.validate(browser, sandboxed);
  }

  protected async setup(workspace: string) {
    this.workspace = workspace;
    this.instructions = e2eInstructions(this.context.fixture);
    if (!this.context.targetUrl)
      throw new Error("Agent fixture URL is missing.");
    this.journal = path.join(
      this.context.runDirectory,
      "e2e-model-calls.jsonl",
    );
    return {
      env: await prepareE2E({
        workspace,
        skillOwner: this.options.skillOwner,
        fixture: this.context.fixture,
        targetUrl: this.context.targetUrl,
        model: this.options.e2eModel,
        journal: this.journal,
        runtime: this.runtime,
        broker:
          this.options.browser === "local"
            ? undefined
            : (await this.connect()).env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
      }),
    };
  }

  async cost(model: AgentCost | null, modelComplete: boolean) {
    const cost = await super.cost(model, modelComplete);
    return this.journal ? addE2ECost(cost, this.journal) : cost;
  }

  async close() {
    const { workspace } = this;
    try {
      if (this.journal && workspace)
        // Keep the bug-bash config, charters, repro tests and e2e reports as evidence.
        await cp(
          workspace,
          path.join(this.context.runDirectory, "e2e-workspace"),
          {
            recursive: true,
            filter: (entry) =>
              ![".agents", ".claude", "node_modules"].includes(
                path.relative(workspace, entry).split(path.sep)[0],
              ),
          },
        );
    } finally {
      await super.close();
    }
  }
}

const BROWSER_TOOLS = {
  "playwright-mcp": PlaywrightMcp,
  "agent-browser": AgentBrowser,
  e2e: E2E,
} satisfies Record<BrowserTool, unknown>;
