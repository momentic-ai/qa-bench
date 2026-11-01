import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { AgentContext, EvalAgent } from "../../evals/agent";
import { BrowserCost, combinedCost } from "../../evals/browser-cost";
import { getCodexCost } from "../../evals/cost";
import { writeJson } from "../../evals/json-file";
import {
  CodexAppServer,
  CodexNotification,
  loginCodexWithApiKey,
} from "./codex-app-server";
import { FINDINGS_TOOLS, FindingsStore } from "./findings-store";

// The brief can exceed the goal limit, so the objective points to the first turn, which carries it in full.
const GOAL_OBJECTIVE =
  "Complete the evaluation task given in full in this thread's first user message: test the assigned target end to end, save findings with the reporting tools, and follow any later finalization instructions.";
const require = createRequire(import.meta.url);

export type CodexSetup = {
  mcpServers: Record<string, unknown>;
  env?: Record<string, string>;
  sandbox?: "workspace-write";
  subagents?: boolean;
  webSearch?: "disabled";
  /** Appended to the task brief. */
  instructions?: string;
};

export abstract class CodexRunner implements EvalAgent {
  readonly preparesEnvironment = true;
  private server: CodexAppServer | undefined;
  private threadId: string | undefined;
  private store: FindingsStore;
  protected codexHome: string;
  protected temporaryWorkspace: string | undefined;
  private execution = new AbortController();
  private pending: Promise<unknown>[] = [];
  private subagentFailures: {
    threadId: string;
    turnId: string;
    error: unknown;
  }[] = [];

  constructor(
    protected context: AgentContext,
    protected model: string,
    protected command = path.join(
      path.dirname(require.resolve("@openai/codex/package.json")),
      "bin/codex.js",
    ),
  ) {
    this.store = new FindingsStore(context.reportDirectory);
    this.codexHome = path.join(context.runDirectory, "codex-home");
  }

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    // Mo's clock includes its sandbox and browser startup, and its server-side session budget
    // starts with the session, so Codex's own login, app-server and browser startup count too.
    onReady?.();
    await this.store.initialize();
    const workspace = await this.createWorkspace();
    const setup = await this.prepare();
    await Promise.all([
      mkdir(this.codexHome, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    const env = {
      ...setup.env,
      PATH: setup.env?.PATH ?? process.env.PATH ?? "",
      HOME: process.env.HOME || "",
      USERPROFILE: process.env.USERPROFILE || "",
      SYSTEMROOT: process.env.SYSTEMROOT || "",
      CODEX_HOME: this.codexHome,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    };
    await loginCodexWithApiKey(
      this.command,
      env,
      process.env.OPENAI_API_KEY || "",
      signal,
    );
    this.server = new CodexAppServer(
      this.command,
      env,
      async (threadId, tool, args) => {
        if (threadId !== this.threadId) {
          throw new Error(
            "Send your findings to the parent; only the root agent accepts eval results.",
          );
        }
        await this.store.handleTool(tool, args);
      },
    );
    await this.server.initialize(signal);
    const { thread } = z.object({ thread: z.object({ id: z.string() }) }).parse(
      await this.server.request(
        "thread/start",
        {
          model: this.model,
          cwd: workspace,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: "never",
          ...(setup.sandbox ? { sandbox: setup.sandbox } : {}),
          dynamicTools: FINDINGS_TOOLS,
          config: {
            model_reasoning_effort: "medium",
            ...(setup.webSearch ? { web_search: setup.webSearch } : {}),
            ...(setup.sandbox
              ? { sandbox_workspace_write: { network_access: true } }
              : {}),
            mcp_servers: setup.mcpServers,
            agents: {
              enabled: setup.subagents,
              default_subagent_model: this.model,
              default_subagent_reasoning_effort: "medium",
            },
          },
        },
        signal,
      ),
    );
    this.threadId = thread.id;
    const task = [
      message,
      setup.instructions,
      "Use submit_bug to save each bug with a stable ID, remove_bug to retract it, and record_coverage for areas explored and limitations.",
    ]
      .filter(Boolean)
      .join("\n\n");
    process.stdout.write(
      `${this.context.fixture.name}: Codex session ${thread.id}\n`,
    );
    onReady?.();
    await this.server.startGoal({
      threadId: thread.id,
      task,
      objective: GOAL_OBJECTIVE,
      signal,
      persistent: false,
    });
    const completion = this.server.waitForCompletion(
      thread.id,
      AbortSignal.any([signal, this.execution.signal]),
      (event) => this.handleProgress(event),
      false,
    );
    // Own the observer even if termination precedes the caller awaiting completion.
    this.pending.push(Promise.allSettled([completion]));
    return { completion };
  }

  async send(message: string, signal: AbortSignal) {
    const { server, threadId } = this;
    if (!server || !threadId) throw new Error("Codex session did not start.");
    const delivery = server.sendMessage(
      threadId,
      message,
      AbortSignal.any([signal, this.execution.signal]),
    );
    this.pending.push(Promise.allSettled([delivery]));
    await delivery;
  }

  async terminate() {
    this.execution.abort();
    this.store.seal();
    try {
      // Closing the dedicated app-server kills its process group and awaits tool handlers.
      await this.server?.close();
    } finally {
      await Promise.all(this.pending);
      await Promise.all([
        rm(path.join(this.codexHome, "auth.json"), { force: true }),
        this.cleanup(),
      ]);
    }
  }

  async collectResults(signal: AbortSignal) {
    signal.throwIfAborted();
    const report = await this.store.collect();
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      report,
    );
    const cost = await this.collectCost();
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), cost);
    return {
      bugCount: report.bugs.length,
      costUsd: cost?.estimatedUsd ?? null,
      sessionId: this.threadId,
    };
  }

  protected async collectCost() {
    let cost = null;
    try {
      cost = await getCodexCost(this.codexHome);
    } catch (err) {
      process.stderr.write(
        `${this.context.fixture.name}: could not collect Codex cost: ${err}\n`,
      );
    }
    const browser = await this.collectBrowserCost();
    return browser
      ? {
          ...cost,
          ...combinedCost(cost?.estimatedUsd ?? null, cost !== null, browser),
        }
      : cost;
  }

  protected async collectBrowserCost(): Promise<BrowserCost | undefined> {
    return undefined;
  }

  protected async createWorkspace() {
    this.temporaryWorkspace = await mkdtemp(
      path.join(tmpdir(), "qa-bench-agent-"),
    );
    return this.temporaryWorkspace;
  }

  protected abstract prepare(): Promise<CodexSetup>;

  protected abstract cleanup(): Promise<void>;

  private async handleProgress(event: CodexNotification) {
    if (
      event.method === "turn/completed" &&
      event.params?.threadId &&
      event.params.threadId !== this.threadId &&
      event.params?.turn?.status === "failed"
    ) {
      const { threadId, turn } = event.params;
      const failure = { threadId, turnId: turn.id, error: turn.error };
      this.subagentFailures.push(failure);
      await writeJson(
        path.join(this.context.reportDirectory, "subagent-failures.json"),
        this.subagentFailures,
      );
      return;
    }
    const item = event.params?.item;
    if (event.method !== "item/completed" || !item) return;
    let detail = item.type;
    switch (item.type) {
      case "agentMessage":
        detail = item.text ?? item.type;
        break;
      case "mcpToolCall":
        detail = `${item.server}.${item.tool}`;
        break;
      case "dynamicToolCall":
      case "collabAgentToolCall":
        detail = item.tool ?? item.type;
        break;
    }
    process.stdout.write(`${this.context.fixture.name}: ${detail}\n`);
  }
}
