import { rm } from "node:fs/promises";
import path from "node:path";

import { AgentContext, AgentCost, Browser } from "../agents/types";
import { combinedCost } from "./browser-cost";
import { BrowserbaseSessions } from "./browsers/browserbase";
import {
  LocalChromium,
  localBrowserConnection,
  validateLocalChromium,
} from "./browsers/local-browser";
import { E2EModel } from "./drivers/e2e/harness";
import { BrowserRecorder } from "./recording/browser-recorder";
import { cutBugVideos } from "./recording/bug-videos";

export type BrowserTool = "playwright-mcp" | "agent-browser" | "e2e";

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
