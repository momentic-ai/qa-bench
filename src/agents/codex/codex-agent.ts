import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

import {
  AgentContext,
  Browser,
  CODEX_MODELS,
  CodexModel,
  EvalAgentDefinition,
} from "../../evals/agent";
import { getCodexCost } from "../../evals/cost";
import { writeJson } from "../../evals/json-file";
import { BrowserTool } from "../agent-browser";
import { CodingAgent } from "../coding-agent";
import {
  DISABLED_BROWSER_TOOL,
  PreparedBrowser,
  TestingBrowser,
} from "../testing-browser";
import {
  CodexAppServer,
  CodexNotification,
  loginCodexWithApiKey,
} from "./codex-app-server";
import { FINDINGS_TOOLS } from "./findings-store";

const require = createRequire(import.meta.url);
export const CODEX_PACKAGE = require.resolve("@openai/codex/package.json");
export const CODEX_COMMAND = path.join(
  path.dirname(CODEX_PACKAGE),
  "bin/codex.js",
);

// The brief can exceed the goal limit, so the objective points to the first turn, which carries it in full.
const GOAL_OBJECTIVE =
  "Complete the evaluation task given in full in this thread's first user message: test the assigned target end to end, save findings with the reporting tools, and follow any later finalization instructions.";

export class CodexAgent extends CodingAgent {
  static family = "codex" as const;
  static apiKey = "OPENAI_API_KEY";
  static skillOwner = ".agents" as const;
  static e2eProvider = "openai" as const;
  static apiHost = "api.openai.com";
  protected findingsToolPrefix = "";
  private server: CodexAppServer | undefined;
  private codexHome: string;
  private execution = new AbortController();
  private pending: Promise<unknown>[] = [];
  private subagentFailures: {
    threadId: string;
    turnId: string;
    error: unknown;
  }[] = [];

  constructor(
    context: AgentContext,
    model: string,
    browser: TestingBrowser,
    sandboxed: boolean,
  ) {
    super(context, model, browser, sandboxed);
    this.codexHome = path.join(context.runDirectory, "codex-home");
  }

  protected async launch(
    task: string,
    setup: PreparedBrowser,
    signal: AbortSignal,
    onReady?: () => number,
  ) {
    const { workspace } = this;
    await mkdir(this.codexHome, { recursive: true });
    const env = {
      ...setup.env,
      PATH: setup.env?.PATH ?? this.runtime.pathEnv([]),
      HOME: process.env.HOME || "",
      USERPROFILE: process.env.USERPROFILE || "",
      SYSTEMROOT: process.env.SYSTEMROOT || "",
      CODEX_HOME: this.codexHome,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    };
    await loginCodexWithApiKey(
      this.runtime,
      CODEX_COMMAND,
      env,
      process.env.OPENAI_API_KEY || "",
      signal,
    );
    this.server = new CodexAppServer(
      this.runtime,
      CODEX_COMMAND,
      env,
      async (threadId, tool, args) => {
        if (threadId !== this.sessionId) {
          throw new Error(
            "Send your findings to the parent; only the root agent accepts eval results.",
          );
        }
        await this.findings.handleTool(tool, args);
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
          // The run's sandbox container is the boundary. Codex's own per-command
          // sandbox would kill the agent-browser daemon and e2e's explorers.
          sandbox: "danger-full-access",
          dynamicTools: FINDINGS_TOOLS,
          config: {
            model_reasoning_effort: "medium",
            ...(this.browser.options.preventCheating
              ? { web_search: "disabled" }
              : {}),
            mcp_servers: setup.playwright
              ? {
                  playwright: {
                    ...setup.playwright,
                    startup_timeout_sec: 60,
                    tool_timeout_sec: 120,
                    default_tools_approval_mode: "approve",
                    required: true,
                    disabled_tools: [DISABLED_BROWSER_TOOL],
                  },
                }
              : {},
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
    this.sessionId = thread.id;
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
    const { server, sessionId: threadId } = this;
    if (!server || !threadId) throw new Error("Codex session did not start.");
    const delivery = server.sendMessage(
      threadId,
      message,
      AbortSignal.any([signal, this.execution.signal]),
    );
    this.pending.push(Promise.allSettled([delivery]));
    await delivery;
  }

  protected async stop() {
    this.execution.abort();
    try {
      // Closing the dedicated app-server kills its process group and awaits tool handlers.
      await this.server?.close();
    } finally {
      await Promise.all(this.pending);
      await rm(path.join(this.codexHome, "auth.json"), { force: true });
      // Keep Codex's transcripts with the report; the run directory is deleted after grading.
      await cp(
        path.join(this.codexHome, "sessions"),
        path.join(this.context.reportDirectory, "codex-sessions"),
        { recursive: true },
      ).catch(() => {});
    }
  }

  protected async modelCost() {
    let cost = null;
    try {
      cost = await getCodexCost(this.codexHome);
    } catch (err) {
      process.stderr.write(
        `${this.context.fixture.name}: could not collect Codex cost: ${err}\n`,
      );
    }
    return { cost, complete: cost !== null };
  }

  private async handleProgress(event: CodexNotification) {
    if (
      event.method === "turn/completed" &&
      event.params?.threadId &&
      event.params.threadId !== this.sessionId &&
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

export function codexAgent(
  browser: Browser,
  browserTool: BrowserTool = "playwright-mcp",
  model: CodexModel = CODEX_MODELS[0],
  preventCheating = false,
  sandboxed = true,
): EvalAgentDefinition {
  return CodexAgent.definition(
    browser,
    browserTool,
    model,
    preventCheating,
    sandboxed,
  );
}
