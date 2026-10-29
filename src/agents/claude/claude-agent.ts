import {
  HookInput,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnOptions,
  SyncHookJSONOutput,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { WriteStream, createWriteStream } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";

import { Browser, EvalAgentDefinition } from "../../evals/agent";
import { combinedCost } from "../../evals/browser-cost";
import { writeJson } from "../../evals/json-file";
import { BrowserTool, validateAgentBrowser } from "../agent-browser";
import { CodexAgent } from "../codex/codex-agent";
import { FindingsStore } from "../codex/findings-store";
import { validateLocalChromium } from "../local-browser";
import { BrowserProxy } from "./browser-proxy";
import { startReportingServer } from "./reporting";

const require = createRequire(import.meta.url);
const CLAUDE_COMMAND = path.join(
  path.dirname(require.resolve("@anthropic-ai/claude-code/package.json")),
  "bin",
  "claude.exe",
);
const DISABLED_BROWSER_TOOL = "browser_run_code_unsafe";
// Claude Code builds name the subagent tool "Agent" or "Task".
const SUBAGENT_TOOLS = ["Agent", "Task"];
const ORCHESTRATION_TOOLS = [...SUBAGENT_TOOLS, "SendMessage", "TaskStop"];
const FILE_TOOLS = ["Read", "Glob", "Grep"];
const FileToolInputSchema = z
  .object({
    file_path: z.string().optional(),
    path: z.string().optional(),
    pattern: z.string().optional(),
  })
  .passthrough();
const BashInputSchema = z.object({ command: z.string() }).passthrough();
const PlaywrightServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

function denyTool(reason: string): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveThroughLinks(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await resolveThroughLinks(parent), path.basename(target));
  }
}

async function isInside(roots: string[], workspace: string, target: string) {
  const actual = await resolveThroughLinks(path.resolve(workspace, target));
  for (const root of roots) {
    const relative = path.relative(await realpath(root), actual);
    if (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    )
      return true;
  }
  return false;
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage) {
    if (this.closed)
      throw new Error("Claude Code session is not accepting messages.");
    this.messages.push(message);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const message = this.messages.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

export class ClaudeAgent extends CodexAgent {
  protected skillOwner = ".claude" as const;
  private session: Query | undefined;
  private reporting:
    | Awaited<ReturnType<typeof startReportingServer>>
    | undefined;
  private browserProxy: BrowserProxy | undefined;
  private findings = new FindingsStore(this.context.reportDirectory);
  private transcript: WriteStream | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private exit: Promise<void> | undefined;
  private stderr = "";
  private input = new MessageQueue();
  private undelivered = new Set<string>();
  private backgroundTasks = new Set<string>();
  private agentToolUses = new Set<string>();
  private childFailures: {
    taskId: string;
    toolUseId: string;
    summary: string;
  }[] = [];
  private observer: Promise<void> | undefined;
  private stopping = false;
  private modelCost: number | null = null;
  private turnOpen = false;
  private workspace = "";
  private readableRoots: string[] = [];
  private shellSandbox: string[] = [];
  private sessionId: string | undefined;

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    onReady?.();
    await this.findings.initialize();
    const workspace = await this.createWorkspace();
    const configDirectory = path.join(this.context.runDirectory, "claude-home");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
      mkdir(this.codexHome, { recursive: true }),
    ]);
    const setup = await this.prepare();
    const agentBrowser = this.browserTool === "agent-browser";
    const artifacts = path.join(this.context.runDirectory, "browser-artifacts");
    this.workspace = workspace;
    const readable = {
      ":minimal": "read",
      ":workspace_roots": "read",
      [codexRuntimeDirectory()]: "read",
      [path.join(this.codexHome, "tmp", "arg0")]: "read",
      ...(process.platform === "linux"
        ? { [await realpath("/etc/resolv.conf")]: "read" }
        : {}),
      [artifacts]: "read",
    };
    if (!agentBrowser) this.readableRoots = [workspace, artifacts];
    if (!agentBrowser)
      this.shellSandbox = [
        process.execPath,
        this.command,
        "sandbox",
        "--permission-profile",
        "eval",
        "--cd",
        workspace,
        "-c",
        `permissions.eval={filesystem={${Object.entries(readable)
          .map(
            ([file, permission]) =>
              `${JSON.stringify(file)}=${JSON.stringify(permission)}`,
          )
          .join(",")}},network={enabled=false}}`,
        "--",
        "bash",
        "-c",
      ];
    if (!agentBrowser) {
      const servers: Record<string, unknown> = setup.mcpServers;
      const playwright = PlaywrightServerSchema.parse(servers.playwright);
      this.browserProxy = new BrowserProxy({
        command: playwright.command,
        args: playwright.args,
        env: {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || "",
          ...playwright.env,
        },
        disabledTools: [DISABLED_BROWSER_TOOL],
      });
    }
    const browserUrl = await this.browserProxy?.start();
    this.reporting = await startReportingServer(this.findings);
    signal.throwIfAborted();
    this.transcript = createWriteStream(
      path.join(this.context.reportDirectory, "transcript.jsonl"),
    );
    const tools = [
      ...(setup.subagents === false ? [] : ORCHESTRATION_TOOLS),
      ...FILE_TOOLS,
      "Bash",
      "TodoWrite",
      ...(agentBrowser ? ["Skill"] : []),
    ];
    this.session = query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: CLAUDE_COMMAND,
        cwd: workspace,
        model: "claude-opus-5-5",
        effort: "medium",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: agentBrowser ? ["project"] : [],
        ...(agentBrowser ? {} : { skills: [] }),
        tools,
        allowedTools: [...tools, "mcp__playwright__*", "mcp__reporting__*"],
        disallowedTools: [`mcp__playwright__${DISABLED_BROWSER_TOOL}`],
        permissionMode: "dontAsk",
        mcpServers: {
          ...(browserUrl
            ? {
                playwright: {
                  type: "http" as const,
                  url: browserUrl,
                  timeout: 120_000,
                },
              }
            : {}),
          reporting: { type: "http", url: this.reporting.url },
        },
        hooks: {
          PreToolUse: [{ hooks: [async (input) => this.guardTool(input)] }],
          SubagentStop: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === "SubagentStop")
                    await this.browserProxy?.release(input.agent_id);
                  return {};
                },
              ],
            },
          ],
        },
        env: {
          ...setup.env,
          PATH: setup.env?.PATH ?? process.env.PATH,
          HOME: process.env.HOME,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CLAUDE_CONFIG_DIR: configDirectory,
          CODEX_HOME: this.codexHome,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        spawnClaudeCodeProcess: (options) => this.spawn(options),
      },
    });
    this.enqueue(
      `${message}\n\nUse reporting.submit_bug to save each bug with a stable ID, reporting.remove_bug to retract it, and reporting.record_coverage for areas explored and limitations.`,
    );
    this.observer = this.observe(this.session);
    void this.observer.catch(() => {});
    return { completion: this.observer };
  }

  async send(message: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.session) throw new Error("Claude Code session did not start.");
    this.enqueue(message);
  }

  async terminate() {
    this.stopping = true;
    this.findings.seal();
    this.input.close();
    try {
      await this.stopProcessGroup();
    } finally {
      this.session?.close();
      await this.observer?.catch(() => {});
      if (this.transcript) {
        this.transcript.end();
        await finished(this.transcript);
      }
      await Promise.all([this.reporting?.close(), this.browserProxy?.close()]);
      await this.cleanup();
    }
  }

  async collectResults(signal: AbortSignal) {
    signal.throwIfAborted();
    const report = await this.findings.collect();
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      report,
    );
    const modelCostComplete = this.modelCost !== null && !this.turnOpen;
    const browser = await this.collectBrowserCost();
    const cost = browser
      ? combinedCost(this.modelCost, modelCostComplete, browser)
      : {
          estimatedUsd: this.modelCost,
          costComplete: this.localBrowser && modelCostComplete,
        };
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), cost);
    return {
      bugCount: report.bugs.length,
      costUsd: cost.estimatedUsd,
      sessionId: this.sessionId,
    };
  }

  private enqueue(text: string) {
    const uuid = randomUUID();
    this.undelivered.add(uuid);
    this.input.push({
      type: "user",
      uuid,
      parent_tool_use_id: null,
      priority: "next",
      message: { role: "user", content: text },
    });
  }

  private async observe(session: Query) {
    for await (const message of session) {
      this.transcript?.write(`${JSON.stringify(message)}\n`);
      if (!this.sessionId) {
        this.sessionId = message.session_id;
        process.stdout.write(
          `${this.context.fixture.name}: Claude session ${this.sessionId}\n`,
        );
      }
      this.logProgress(message);
      if (message.type === "assistant") {
        this.turnOpen = true;
        if (!message.parent_tool_use_id) {
          for (const block of message.message.content) {
            if (
              block.type === "tool_use" &&
              SUBAGENT_TOOLS.includes(block.name)
            )
              this.agentToolUses.add(block.id);
          }
        }
      }
      if (
        message.type === "system" &&
        message.subtype === "task_notification" &&
        message.status === "failed" &&
        message.tool_use_id &&
        this.agentToolUses.has(message.tool_use_id)
      ) {
        await this.recordSubagentFailure(
          message.task_id,
          message.tool_use_id,
          message.summary,
        );
      }
      if (
        (message.type === "assistant" || message.type === "result") &&
        message.user_message_uuid
      ) {
        for (const uuid of message.user_message_uuids ?? [
          message.user_message_uuid,
        ])
          this.undelivered.delete(uuid);
      }
      if (
        message.type === "system" &&
        message.subtype === "background_tasks_changed"
      ) {
        this.backgroundTasks = new Set(
          message.tasks
            .filter((task) => !task.ambient)
            .map((task) => task.task_id),
        );
      }
      if (message.type !== "result") continue;
      this.modelCost = message.total_cost_usd;
      this.turnOpen = false;
      if (message.subtype !== "success")
        throw new Error(
          `Claude turn failed (${message.subtype}): ${message.errors.join("; ")}`,
        );
      if (this.undelivered.size === 0 && this.backgroundTasks.size === 0)
        this.input.close();
    }
    if (!this.stopping && this.modelCost === null)
      throw new Error(`Claude Code exited without a result: ${this.stderr}`);
  }

  private async recordSubagentFailure(
    taskId: string,
    toolUseId: string,
    summary: string,
  ) {
    this.childFailures.push({ taskId, toolUseId, summary });
    await writeJson(
      path.join(this.context.reportDirectory, "subagent-failures.json"),
      this.childFailures,
    );
    this.enqueue(
      `Subagent ${taskId} failed: ${summary}\nDecide whether to recover this task within the remaining budget. Do not retry or reassign policy-refused work. Continue unaffected testing and record unfinished coverage as limitations.`,
    );
  }

  private async guardTool(input: HookInput): Promise<SyncHookJSONOutput> {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name.startsWith("mcp__playwright__")) {
      this.browserProxy?.assign(input.tool_use_id, input.agent_id);
      return {};
    }
    if (input.agent_id && input.tool_name.startsWith("mcp__reporting__")) {
      return denyTool(
        "Send your findings to the parent; only the root agent accepts eval results.",
      );
    }
    if (input.tool_name === "Bash" && this.shellSandbox.length) {
      const bash = BashInputSchema.parse(input.tool_input);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...bash,
            command: [...this.shellSandbox, bash.command]
              .map(shellQuote)
              .join(" "),
          },
        },
      };
    }
    if (FILE_TOOLS.includes(input.tool_name) && this.readableRoots.length) {
      const {
        file_path,
        path: searchPath,
        pattern,
      } = FileToolInputSchema.parse(input.tool_input);
      const targets = [file_path, searchPath];
      if (input.tool_name === "Glob" && pattern && path.isAbsolute(pattern))
        targets.push(pattern.split(/[*?[{]/)[0]);
      for (const target of targets) {
        if (
          target !== undefined &&
          !(await isInside(this.readableRoots, this.workspace, target))
        )
          return denyTool(`${target}: No such file or directory`);
      }
    }
    return {};
  }

  private spawn({ command, args, cwd, env }: SpawnOptions) {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exit = new Promise((resolve) => child.once("close", () => resolve()));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    return child;
  }

  private async stopProcessGroup() {
    const child = this.child;
    if (!child?.pid || !this.exit) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ESRCH"))
        throw err;
    }
    await this.exit;
  }

  private logProgress(message: SDKMessage) {
    if (message.type !== "assistant") return;
    const prefix = message.parent_tool_use_id
      ? `${this.context.fixture.name} (subagent)`
      : this.context.fixture.name;
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim())
        process.stdout.write(`${prefix}: ${block.text}\n`);
      else if (block.type === "tool_use")
        process.stdout.write(`${prefix}: ${block.name}\n`);
    }
  }
}

export function claudeAgent(
  browser: Browser,
  browserTool: BrowserTool = "playwright-mcp",
): EvalAgentDefinition {
  return {
    name: `claude-${browserTool}`,
    reportSubdirectory: `claude-${browserTool}`,
    concurrency: browser === "local" ? 2 : Infinity,
    config: {
      browser,
      ...(browserTool === "playwright-mcp"
        ? { subagents: browser !== "local" }
        : {}),
    },
    async validateEnvironment() {
      if (!process.env.ANTHROPIC_API_KEY)
        throw new Error("ANTHROPIC_API_KEY is required.");
      if (browserTool === "agent-browser") await validateAgentBrowser();
      if (browser === "local") await validateLocalChromium();
      else if (!process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required.");
      await promisify(execFile)(CLAUDE_COMMAND, ["--version"]);
    },
    create(context) {
      return browser === "local"
        ? new LocalClaudeAgent(context, browserTool)
        : new ClaudeAgent(context, browserTool);
    },
  };
}

class LocalClaudeAgent extends ClaudeAgent {
  protected localBrowser = true;
}

function codexRuntimeDirectory() {
  return path.dirname(
    createRequire(require.resolve("@openai/codex/package.json")).resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    ),
  );
}
