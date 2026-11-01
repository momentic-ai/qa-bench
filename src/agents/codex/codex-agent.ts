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
import { CodexRunner, CodexSetup } from "./codex-runner";

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
    protected preventCheating = false,
  ) {
    super(context, model);
  }

  protected async prepare(): Promise<CodexSetup> {
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
        // A local agent-browser has no site limits, so don't tell Codex otherwise.
        ...this.cheatingSetup(!this.localBrowser),
      };
    }
    return {
      mcpServers: await this.prepareBrowserMcp(),
      subagents: !this.localBrowser,
      ...this.cheatingSetup(true),
    };
  }

  private cheatingSetup(sitesBlocked: boolean) {
    if (!this.preventCheating) return {};
    return {
      webSearch: "disabled" as const,
      ...(sitesBlocked
        ? {
            instructions:
              "Some external sites are blocked. Record flows that need one as coverage limitations, not bugs.",
          }
        : {}),
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
    let allowedDomains: string[] | undefined;
    if (this.preventCheating) {
      if (!this.context.targetUrl)
        throw new Error("--prevent-cheating needs the fixture URL.");
      allowedDomains = [this.context.targetUrl.hostname];
    }
    this.browsers = new BrowserbaseSessions(
      path.join(this.context.runDirectory, "browser-sessions"),
      process.env.BROWSERBASE_API_KEY || "",
      { allowedDomains },
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
          ...(this.preventCheating
            ? ["--blocked-origins", ANSWER_SOURCES.join(";")]
            : []),
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
  preventCheating = false,
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
      ...(preventCheating ? { preventCheating } : {}),
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
        ? new LocalCodexAgent(context, browserTool, model, preventCheating)
        : new CodexAgent(context, browserTool, model, preventCheating);
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
