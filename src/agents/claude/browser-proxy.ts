import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

import { ToolResultSchema, ToolSchema, sdkMcpServer } from "./sdk-mcp";

const PARENT = "parent";
const TOOL_TIMEOUT_MS = 120_000;
const ResponseSchema = z
  .object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type BrowserLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  disabledTools: string[];
};

class PlaywrightProcess {
  private child: ChildProcessWithoutNullStreams;
  private exit: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(result: unknown): void; reject(err: unknown): void }
  >();
  private failure: unknown;
  private stderr = "";
  private ready: Promise<unknown>;

  constructor(launch: BrowserLaunch) {
    this.child = spawn(launch.command, launch.args, {
      env: launch.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    this.child.on("error", (err) => this.fail(err));
    this.child.stdin.on("error", (err) => this.fail(err));
    this.child.once("exit", (code) =>
      this.fail(new Error(`Playwright MCP exited (${code}): ${this.stderr}`)),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.stderr = `${this.stderr}${line}\n`.slice(-2000);
        return;
      }
      const parsed = ResponseSchema.safeParse(message);
      if (!parsed.success) return;
      const waiter = this.pending.get(parsed.data.id);
      if (!waiter) return;
      this.pending.delete(parsed.data.id);
      if (parsed.data.error !== undefined)
        waiter.reject(new Error(JSON.stringify(parsed.data.error)));
      else waiter.resolve(parsed.data.result);
    });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "qa-bench-browser-proxy", version: "1.0.0" },
    })
      .then(() => this.notify("notifications/initialized"))
      .catch((err: unknown) => {
        this.fail(err);
        throw err;
      });
  }

  get failed() {
    return this.failure !== undefined;
  }

  async call(method: string, params: unknown) {
    await this.ready;
    return this.request(method, params);
  }

  async close() {
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (this.child.pid && process.platform !== "win32")
          process.kill(-this.child.pid, signal);
        else if (this.child.exitCode === null) this.child.kill(signal);
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ESRCH"))
          throw err;
      }
    };
    kill("SIGTERM");
    const forceKill = setTimeout(() => kill("SIGKILL"), 1000);
    try {
      await this.exit;
      kill("SIGKILL");
    } finally {
      clearTimeout(forceKill);
    }
  }

  private request(method: string, params: unknown) {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser tool timed out after ${TOOL_TIMEOUT_MS}ms.`));
      }, TOOL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private fail(err: unknown) {
    this.failure ??= err;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

export class BrowserProxy {
  private browsers = new Map<string, PlaywrightProcess>();
  private callers = new Map<string, string>();
  private tools: Promise<unknown> | undefined;
  private closing = false;

  constructor(private launch: BrowserLaunch) {}

  assign(toolUseId: string, agentId: string | undefined) {
    this.callers.set(toolUseId, agentId ?? PARENT);
  }

  async release(agentId: string) {
    const browser = this.browsers.get(agentId);
    this.browsers.delete(agentId);
    await browser?.close();
  }

  server() {
    return sdkMcpServer({
      name: "playwright",
      instructions:
        "Each agent, including each subagent, gets its own separate browser.",
      timeout: TOOL_TIMEOUT_MS,
      listTools: async () => {
        this.tools ??= this.browser(PARENT)
          .call("tools/list", {})
          .catch((err: unknown) => {
            this.tools = undefined;
            throw err;
          });
        return z
          .object({ tools: z.array(ToolSchema) })
          .parse(await this.tools)
          .tools.filter(
            (tool) => !this.launch.disabledTools.includes(tool.name),
          );
      },
      callTool: async (call) => {
        if (this.launch.disabledTools.includes(call.name))
          throw new Error(`Unknown tool: ${call.name}`);
        const toolUseId = call._meta?.["claudecode/toolUseId"];
        const agent = (toolUseId && this.callers.get(toolUseId)) ?? PARENT;
        if (toolUseId) this.callers.delete(toolUseId);
        return ToolResultSchema.parse(
          await this.browser(agent).call("tools/call", {
            name: call.name,
            arguments: call.arguments ?? {},
          }),
        );
      },
    });
  }

  async close() {
    this.closing = true;
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((browser) => browser.close()));
  }

  private browser(agent: string) {
    if (this.closing) throw new Error("The browser is shutting down.");
    let browser = this.browsers.get(agent);
    if (!browser || browser.failed) {
      browser
        ?.close()
        .catch((err: unknown) =>
          process.stderr.write(`Could not stop a failed browser: ${err}\n`),
        );
      browser = new PlaywrightProcess(this.launch);
      this.browsers.set(agent, browser);
    }
    return browser;
  }
}
