import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeJson } from "../shared/json-file";
import { BrowserTool } from "./agent-browser";
import { BrowserCost } from "./browser-cost";
import { FindingsStore } from "./codex/findings-store";
import { E2EModel } from "./e2e/config";
import { ContainerAgent } from "./sandbox/container-agent";
import { ensureSandboxImage } from "./sandbox/image";
import {
  BrowserOptions,
  PreparedBrowser,
  TestingBrowser,
} from "./testing-browser";
import {
  AgentCost,
  AgentExecution,
  Browser,
  CodingAgentContext,
  EvalAgent,
  EvalAgentDefinition,
} from "./types";

/** A run's agent settings, sent to its container. */
export type CodingAgentSettings = {
  family: "codex" | "claude";
  browser: Browser;
  browserTool: BrowserTool;
  model: string;
  recordBugs: boolean;
};

type CodingAgentClass = {
  new (
    context: CodingAgentContext,
    model: string,
    browser: TestingBrowser,
  ): CodingAgent;
  family: "codex" | "claude";
  apiKey: string;
  /** The model API host the sandbox allows. */
  apiHost: string;
  skillOwner: BrowserOptions["skillOwner"];
  e2eProvider: E2EModel["provider"];
};

/** Codex or Claude Code in a run's container; subclasses drive the model. */
export abstract class CodingAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  protected findings: FindingsStore;
  protected workspace = "";
  protected sessionId: string | undefined;
  /** How the agent names the findings tools, such as "reporting.". */
  protected abstract findingsToolPrefix: string;

  static definition(
    this: CodingAgentClass,
    browser: Browser,
    browserTool: BrowserTool,
    model: string,
    recordBugs: boolean,
  ): EvalAgentDefinition {
    const name = `${this.family}-${browserTool}`;
    const settings: CodingAgentSettings = {
      family: this.family,
      browser,
      browserTool,
      model,
      recordBugs,
    };
    return {
      name,
      reportSubdirectory: name,
      concurrency: browser === "local" ? 2 : Infinity,
      config: {
        model,
        browser,
        ...(browserTool === "playwright-mcp"
          ? { subagents: browser !== "local" }
          : {}),
        // Saved runs without it ran outside the sandbox; merge labels them apart.
        sandbox: true,
        ...(recordBugs ? { recordBugs } : {}),
      },
      validateEnvironment: async () => {
        // Only a local Chromium the harness launches is recorded.
        if (recordBugs && (browserTool === "e2e" || browser !== "local"))
          throw new Error("Bug recording needs a local, non-e2e browser.");
        if (!process.env[this.apiKey])
          throw new Error(`${this.apiKey} is required.`);
        await TestingBrowser.for(browserTool).validate(browser);
        await ensureSandboxImage();
      },
      create: (context) =>
        new ContainerAgent(context, settings, {
          apiKey: this.apiKey,
          apiHost: this.apiHost,
        }),
    };
  }

  /** Builds the agent the container's driver runs. */
  static create(
    this: CodingAgentClass,
    context: CodingAgentContext,
    settings: CodingAgentSettings,
    broker?: string,
  ) {
    const Tool = TestingBrowser.for(settings.browserTool);
    return new this(
      context,
      settings.model,
      new Tool(context, {
        browser: settings.browser,
        recordBugs: settings.recordBugs,
        skillOwner: this.skillOwner,
        e2eModel: { provider: this.e2eProvider, id: settings.model },
        broker,
      }),
    );
  }

  constructor(
    protected context: CodingAgentContext,
    protected model: string,
    protected browser: TestingBrowser,
  ) {
    this.findings = new FindingsStore(context.reportDirectory);
  }

  protected abstract launch(
    brief: string,
    setup: PreparedBrowser,
    signal: AbortSignal,
    onReady?: () => number,
  ): Promise<AgentExecution>;
  protected abstract stop(): Promise<void>;
  /** The model's own cost, and whether it covers every turn. */
  protected abstract modelCost(): Promise<{
    cost: AgentCost | null;
    complete: boolean;
  }>;
  abstract send(message: string, signal: AbortSignal): Promise<void>;

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    // Mo's clock includes its sandbox and browser startup, and its server-side session budget
    // starts with the session, so the coding agent's own startup counts too.
    onReady?.();
    await this.findings.initialize();
    await mkdir(this.context.runDirectory, { recursive: true });
    this.workspace = await mkdtemp(path.join(tmpdir(), "qa-bench-agent-"));
    const setup = await this.browser.prepare(this.workspace);
    const p = this.findingsToolPrefix;
    const brief = [
      message,
      setup.instructions,
      `Use ${p}submit_bug to save each bug with a stable ID, ${p}remove_bug to retract it, and ${p}record_coverage for areas explored and limitations.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.launch(brief, setup, signal, onReady);
  }

  async terminate() {
    this.findings.seal();
    try {
      // Videos help human review but never block shutdown.
      await this.browser.stopRecording().catch(() => {});
      await this.stop();
    } finally {
      await this.browser.close();
      if (this.workspace)
        await rm(this.workspace, { recursive: true, force: true });
    }
  }

  /** `browserCost` comes from the harness's Browserbase broker. */
  async collectResults(signal: AbortSignal, browserCost?: BrowserCost) {
    signal.throwIfAborted();
    const reportFile = path.join(this.context.reportDirectory, "report.json");
    let report = await this.findings.collect();
    await writeJson(reportFile, report);
    const model = await this.modelCost();
    const cost = await this.browser.cost(
      model.cost,
      model.complete,
      browserCost,
    );
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), cost);
    if (this.browser.options.recordBugs)
      try {
        const { recordings, errors } = await this.browser.recordBugs(
          await this.findings.submissions(),
          // Leave the rest of the collection budget for grading's inputs.
          AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        );
        await this.findings.attachRecordings(recordings);
        report = await this.findings.collect();
        await writeJson(reportFile, report);
        if (errors.length) {
          process.stderr.write(`Bug videos incomplete: ${errors.join(", ")}\n`);
          await writeJson(
            path.join(this.context.reportDirectory, "recording-errors.json"),
            errors,
          );
        }
      } catch (err) {
        // Videos help human review but never decide a run's result.
        process.stderr.write(`Bug videos failed: ${String(err)}\n`);
      }
    return {
      bugCount: report.bugs.length,
      costUsd: cost?.estimatedUsd ?? null,
      sessionId: this.sessionId,
    };
  }
}
