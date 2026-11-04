import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentContext,
  AgentExecution,
  Browser,
  EvalAgent,
  EvalAgentDefinition,
} from "../evals/agent";
import { AgentCost } from "../evals/cost";
import { writeJson } from "../evals/json-file";
import { BrowserTool } from "./agent-browser";
import { FindingsStore } from "./codex/findings-store";
import { E2EModel } from "./e2e/config";
import {
  BrowserOptions,
  PreparedBrowser,
  TestingBrowser,
} from "./testing-browser";

type CodingAgentClass = {
  new (
    context: AgentContext,
    model: string,
    browser: TestingBrowser,
  ): CodingAgent;
  family: "codex" | "claude";
  apiKey: string;
  skillOwner: BrowserOptions["skillOwner"];
  e2eProvider: E2EModel["provider"];
  validate(): Promise<void>;
};

/** Codex or Claude Code, run locally against one fixture; subclasses drive the model. */
export abstract class CodingAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  protected findings: FindingsStore;
  protected workspace = "";
  protected sessionId: string | undefined;
  /** How the agent names the findings tools, such as "reporting.". */
  protected abstract findingsToolPrefix: string;

  static async validate() {}

  static definition(
    this: CodingAgentClass,
    browser: Browser,
    browserTool: BrowserTool,
    model: string,
    preventCheating: boolean,
  ): EvalAgentDefinition {
    const name = `${this.family}-${browserTool}`;
    const Tool = TestingBrowser.for(browserTool);
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
        ...(preventCheating ? { preventCheating } : {}),
      },
      validateEnvironment: async () => {
        if (!process.env[this.apiKey])
          throw new Error(`${this.apiKey} is required.`);
        await Tool.validate(browser);
        await this.validate();
      },
      create: (context) =>
        new this(
          context,
          model,
          new Tool(context, {
            browser,
            preventCheating,
            skillOwner: this.skillOwner,
            e2eModel: { provider: this.e2eProvider, id: model },
          }),
        ),
    };
  }

  constructor(
    protected context: AgentContext,
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
      await this.stop();
    } finally {
      await this.browser.close();
      if (this.workspace)
        await rm(this.workspace, { recursive: true, force: true });
    }
  }

  async collectResults(signal: AbortSignal) {
    signal.throwIfAborted();
    const report = await this.findings.collect();
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      report,
    );
    const model = await this.modelCost();
    const cost = await this.browser.cost(model.cost, model.complete);
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), cost);
    return {
      bugCount: report.bugs.length,
      costUsd: cost?.estimatedUsd ?? null,
      sessionId: this.sessionId,
    };
  }
}
