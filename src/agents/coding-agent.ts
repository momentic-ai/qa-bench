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
import { ensureSandboxImage } from "../sandbox/image";
import { HostRuntime, SandboxRuntime, ToolRuntime } from "../sandbox/runtime";
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
    sandboxed: boolean,
  ): CodingAgent;
  family: "codex" | "claude";
  apiKey: string;
  /** The model API the agent and e2e's explorers call. */
  apiHost: string;
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
  protected runtime: ToolRuntime = new HostRuntime();
  /** How the agent names the findings tools, such as "reporting.". */
  protected abstract findingsToolPrefix: string;

  static async validate() {}

  static definition(
    this: CodingAgentClass,
    browser: Browser,
    browserTool: BrowserTool,
    model: string,
    preventCheating: boolean,
    sandboxed: boolean,
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
        ...(sandboxed ? { sandboxed } : {}),
      },
      validateEnvironment: async () => {
        if (!process.env[this.apiKey])
          throw new Error(`${this.apiKey} is required.`);
        await Tool.validate(browser, sandboxed);
        if (sandboxed) await ensureSandboxImage();
        else await this.validate();
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
          sandboxed,
        ),
    };
  }

  constructor(
    protected context: AgentContext,
    protected model: string,
    protected browser: TestingBrowser,
    private sandboxed: boolean,
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
    if (this.sandboxed) this.runtime = await this.startSandbox();
    const setup = await this.browser.prepare(this.workspace, this.runtime);
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

  // The agent reaches its model API and the fixture; harness ports are forwarded as they open.
  private startSandbox() {
    const { targetUrl } = this.context;
    const { apiHost } = this.constructor as unknown as CodingAgentClass;
    return SandboxRuntime.start({
      workspace: this.workspace,
      runDirectory: this.context.runDirectory,
      rules: [
        { host: apiHost, port: 443 },
        ...(targetUrl
          ? [
              {
                host: targetUrl.hostname,
                port:
                  Number(targetUrl.port) ||
                  (targetUrl.protocol === "http:" ? 80 : 443),
              },
            ]
          : []),
      ],
    });
  }

  async terminate() {
    this.findings.seal();
    try {
      await this.stop();
    } finally {
      try {
        await this.browser.close();
      } finally {
        await this.runtime.close();
        if (this.workspace)
          await rm(this.workspace, { recursive: true, force: true });
      }
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
