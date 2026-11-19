import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  BrowserTool,
  closeAgentBrowsers,
  prepareAgentBrowser,
} from "./agent-browser";
import { BrowserCost, combinedCost } from "./browser-cost";
import { BrowserRecorder } from "./browser-recorder";
import { cutBugVideos } from "./bug-videos";
import { E2EModel } from "./e2e/config";
import { addE2ECost, e2eInstructions, prepareE2E } from "./e2e/workspace";
import { LocalChromium, localBrowserConnection } from "./local-browser";
import { CONTAINER_PROXY } from "./sandbox/runtime";
import { AgentCost, Browser, CodingAgentContext } from "./types";

const require = createRequire(import.meta.url);
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
  /** Records each browser and cuts a video clip per bug. */
  recordBugs: boolean;
  /** Where the agent discovers skills. */
  skillOwner: ".agents" | ".claude";
  e2eModel: E2EModel;
  /** The harness's Browserbase broker URL. */
  broker?: string;
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
  private browsers: LocalChromium | undefined;
  /** The run's browser frames and their log, for cutting bug videos. */
  private browserLog: string;
  private frames: string;
  private recorder: BrowserRecorder | undefined;
  protected instructions: string | undefined;

  constructor(
    protected context: CodingAgentContext,
    readonly options: BrowserOptions,
  ) {
    this.artifacts = path.join(context.runDirectory, "browser-artifacts");
    this.browserLog = path.join(context.runDirectory, "browser-log.jsonl");
    this.frames = path.join(context.runDirectory, "browser-frames");
    if (options.recordBugs)
      this.recorder = new BrowserRecorder(this.browserLog, this.frames);
  }

  static for(tool: BrowserTool) {
    return BROWSER_TOOLS[tool];
  }

  static async validate(browser: Browser) {
    if (browser !== "local" && !process.env.BROWSERBASE_API_KEY)
      throw new Error("BROWSERBASE_API_KEY is required.");
  }

  protected abstract setup(workspace: string): Promise<BrowserToolSetup>;

  async prepare(workspace: string): Promise<PreparedBrowser> {
    const setup = await this.setup(workspace);
    const instructions = [
      this.instructions,
      "Some external sites are blocked. Record flows that need one as coverage limitations, not bugs.",
    ].join("\n\n");
    return { instructions, ...setup };
  }

  /** `browser` is the broker's Browserbase charge. */
  async cost(
    model: AgentCost | null,
    modelComplete: boolean,
    browser?: BrowserCost,
  ): Promise<AgentCost | null> {
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

  /** Saves the last frames; runs before the agent and its browser shut down. */
  async stopRecording() {
    await this.recorder?.stop();
  }

  /** Cuts a video clip for each bug from the browsers' frames, then deletes the frames. */
  async recordBugs(
    bugs: { id: string; submittedAt: string }[],
    signal: AbortSignal,
  ) {
    try {
      return await cutBugVideos({
        browserLog: this.browserLog,
        bugs,
        reportDirectory: this.context.reportDirectory,
        signal,
      });
    } finally {
      await rm(this.frames, { recursive: true, force: true });
      await rm(this.browserLog, { force: true });
    }
  }

  protected async connect(): Promise<{
    args: string[];
    env: Record<string, string>;
  }> {
    if (this.options.browser === "local") {
      const { recorder } = this;
      if (!recorder) return localBrowserConnection();
      this.browsers = new LocalChromium((url) => recorder.record(url));
      return {
        args: [],
        env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: await this.browsers.start() },
      };
    }
    if (!this.options.broker)
      throw new Error("Browserbase runs need the harness's broker.");
    return {
      args: [],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: this.options.broker },
    };
  }
}

class PlaywrightMcp extends TestingBrowser {
  protected async setup() {
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
          // For a browser Playwright MCP launches itself.
          ...(browser.args.length ? ["--proxy-server", CONTAINER_PROXY] : []),
          "--output-dir",
          this.artifacts,
          "--blocked-origins",
          ANSWER_SOURCES.join(";"),
        ],
        env: browser.env,
      },
      subagents: this.options.browser !== "local",
    };
  }
}

class AgentBrowser extends TestingBrowser {
  private prepared: Awaited<ReturnType<typeof prepareAgentBrowser>> | undefined;

  protected async setup(workspace: string) {
    this.prepared = await prepareAgentBrowser(
      workspace,
      await this.connect(),
      this.options.skillOwner,
    );
    return { env: this.prepared.env };
  }

  async close() {
    try {
      if (this.prepared)
        await closeAgentBrowsers(this.prepared.env, this.artifacts);
    } finally {
      try {
        await this.prepared?.close();
      } finally {
        await super.close();
      }
    }
  }
}

class E2E extends TestingBrowser {
  private journal: string | undefined;
  private workspace: string | undefined;

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
        broker:
          this.options.browser === "local"
            ? undefined
            : (await this.connect()).env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
      }),
    };
  }

  async cost(
    model: AgentCost | null,
    modelComplete: boolean,
    browser?: BrowserCost,
  ) {
    const cost = await super.cost(model, modelComplete, browser);
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
