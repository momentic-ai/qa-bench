import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { BrowserRecorder } from "./browser-recorder";
import { cutBugVideos } from "./bug-videos";
import { BrowserbaseSessions } from "./codex/browserbase";
import { E2EModel } from "./e2e/config";
import {
  addE2ECost,
  e2eInstructions,
  prepareE2E,
  validateE2E,
} from "./e2e/workspace";
import {
  LocalChromium,
  localBrowserConnection,
  validateLocalChromium,
} from "./local-browser";

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
  /** Records each browser and cuts a video clip per bug. */
  recordBugs: boolean;
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
  /** agent-browser and e2e need network access and background processes from the shell. */
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
  private browsers: BrowserbaseSessions | LocalChromium | undefined;
  /** The run's browser frames and their log, for cutting bug videos. */
  private browserLog: string;
  private frames: string;
  private recorder: BrowserRecorder | undefined;
  protected unsandboxedShell = true;
  /** Whether answer sites are blocked even on a local browser. */
  protected blocksSitesLocally = false;
  protected keepAlive = false;
  protected instructions: string | undefined;

  constructor(
    protected context: AgentContext,
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
    if (browser === "local") await validateLocalChromium();
    else if (!process.env.BROWSERBASE_API_KEY)
      throw new Error("BROWSERBASE_API_KEY is required.");
  }

  protected abstract setup(workspace: string): Promise<BrowserToolSetup>;

  async prepare(workspace: string): Promise<PreparedBrowser> {
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
    return {
      instructions,
      unsandboxedShell: this.unsandboxedShell,
      ...setup,
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

class E2E extends TestingBrowser {
  private journal: string | undefined;
  private workspace: string | undefined;

  static async validate(browser: Browser) {
    await validateE2E();
    // e2e downloads its own pinned Chromium.
    if (browser !== "local") await super.validate(browser);
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
