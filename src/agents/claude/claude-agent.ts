import {
  ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { WriteStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";

import { AgentContext, Browser, EvalAgentDefinition } from "../../evals/agent";
import { combinedCost } from "../../evals/browser-cost";
import { writeJson } from "../../evals/json-file";
import { CodexAgent } from "../codex/codex-agent";
import { FindingsStore } from "../codex/findings-store";
import { validateLocalChromium } from "../local-browser";
import { startReportingServer } from "./reporting";

const require = createRequire(import.meta.url);
const CLAUDE_COMMAND = path.join(
  path.dirname(require.resolve("@anthropic-ai/claude-code/package.json")),
  "cli-wrapper.cjs",
);

const ResultSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  session_id: z.string(),
  total_cost_usd: z.number().nonnegative(),
});

export class ClaudeAgent extends CodexAgent {
  private claude: ChildProcessWithoutNullStreams | undefined;
  private reporting:
    | Awaited<ReturnType<typeof startReportingServer>>
    | undefined;
  private findings: FindingsStore;
  private transcript: WriteStream | undefined;
  private observer: Promise<void> | undefined;
  private processExit: Promise<void> | undefined;
  private stopping = false;
  private modelCost: number | null = null;
  private sessionId: string | undefined;

  constructor(
    context: AgentContext,
    private claudeCommand = CLAUDE_COMMAND,
  ) {
    super(context);
    this.findings = new FindingsStore(context.reportDirectory);
  }

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
    this.reporting = await startReportingServer(this.findings);
    const browser = z
      .object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      })
      .parse(setup.mcpServers.playwright);
    signal.throwIfAborted();
    this.transcript = createWriteStream(
      path.join(this.context.reportDirectory, "transcript.jsonl"),
    );
    const child = spawn(
      process.execPath,
      [
        this.claudeCommand,
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "medium",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            playwright: {
              type: "stdio",
              ...browser,
            },
            reporting: { type: "http", url: this.reporting.url },
          },
        }),
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "mcp__playwright__*",
        "mcp__reporting__*",
        "--setting-sources",
        "",
      ],
      {
        cwd: workspace,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          CLAUDE_CONFIG_DIR: configDirectory,
          DISABLE_AUTOUPDATER: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.claude = child;
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        this.stopping || code === 0
          ? resolve()
          : reject(new Error(`Claude Code exited with code ${code}.`)),
      );
    });
    this.processExit = exited;
    child.stderr.on("data", (chunk) =>
      process.stderr.write(`${this.context.fixture.name}: ${String(chunk)}`),
    );
    const transcript = this.transcript;
    const reading = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        transcript.write(`${line}\n`);
        const event: unknown = JSON.parse(line);
        const result = ResultSchema.safeParse(event);
        if (result.success) {
          this.modelCost = result.data.total_cost_usd;
          this.sessionId = result.data.session_id;
          if (result.data.is_error)
            throw new Error(
              "Claude Code returned an error result; see transcript.jsonl.",
            );
          child.stdin.end();
        }
      }
    })();
    this.observer = Promise.all([exited, reading]).then(() => {
      if (!this.stopping && this.modelCost === null)
        throw new Error("Claude Code exited without a result.");
    });
    void this.observer.catch(() => {});
    child.stdin.on("error", () => {});
    await this.send(
      `${message}\n\nUse reporting.submit_bug to save each bug with a stable ID, reporting.remove_bug to retract it, and reporting.record_coverage for areas explored and limitations.`,
      signal,
    );
    return { completion: this.observer };
  }

  async send(message: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const child = this.claude;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded)
      throw new Error("Claude Code session is not accepting messages.");
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: message } })}\n`,
        (err) => (err ? reject(err) : resolve()),
      ),
    );
  }

  async terminate() {
    this.stopping = true;
    this.findings.seal();
    try {
      if (this.claude?.pid) {
        try {
          process.kill(-this.claude.pid, "SIGKILL");
        } catch (err) {
          if (!(err instanceof Error && "code" in err && err.code === "ESRCH"))
            throw err;
        }
      }
      await this.processExit?.catch(() => {});
      await this.observer?.catch(() => {});
      if (this.transcript) {
        this.transcript.end();
        await finished(this.transcript);
      }
    } finally {
      await Promise.all([this.reporting?.close(), this.cleanup()]);
    }
  }

  async collectResults(signal: AbortSignal) {
    signal.throwIfAborted();
    const report = await this.findings.collect();
    await writeJson(
      path.join(this.context.reportDirectory, "report.json"),
      report,
    );
    const browser = await this.collectBrowserCost();
    const cost = browser
      ? combinedCost(this.modelCost, this.modelCost !== null, browser)
      : {
          estimatedUsd: this.modelCost,
          costComplete: this.localBrowser && this.modelCost !== null,
        };
    await writeJson(path.join(this.context.reportDirectory, "cost.json"), cost);
    return {
      bugCount: report.bugs.length,
      costUsd: cost.estimatedUsd,
      sessionId: this.sessionId,
    };
  }
}

export function claudeAgent(browser: Browser): EvalAgentDefinition {
  return {
    name: "Claude",
    reportSubdirectory: "claude",
    concurrency: browser === "local" ? 2 : Infinity,
    config: { browser },
    async validateEnvironment() {
      if (!process.env.ANTHROPIC_API_KEY)
        throw new Error("ANTHROPIC_API_KEY is required.");
      if (browser === "local") await validateLocalChromium();
      else if (!process.env.BROWSERBASE_API_KEY)
        throw new Error("BROWSERBASE_API_KEY is required.");
      await promisify(execFile)(process.execPath, [
        CLAUDE_COMMAND,
        "--version",
      ]);
    },
    create(context) {
      return browser === "local"
        ? new LocalClaudeAgent(context)
        : new ClaudeAgent(context);
    },
  };
}

class LocalClaudeAgent extends ClaudeAgent {
  protected localBrowser = true;
}
