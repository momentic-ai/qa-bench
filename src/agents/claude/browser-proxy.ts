import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { z } from "zod";

const PARENT = "parent";
const TOOL_TIMEOUT_MS = 120_000;
const RequestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const CallSchema = z
  .object({
    name: z.string(),
    arguments: z.unknown().optional(),
    _meta: z
      .object({ "claudecode/toolUseId": z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const ResponseSchema = z
  .object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
const ToolListSchema = z
  .object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
  .passthrough();

export type BrowserLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  disabledTools: string[];
};

/** One Playwright MCP process (and so one Browserbase session) for a single agent. */
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
        // Stray diagnostics must not throw from the stream callback and crash every fixture.
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
        // A process that just exited is harmless; permission and other failures are not.
        if (!(err instanceof Error && "code" in err && err.code === "ESRCH"))
          throw err;
      }
    };
    kill("SIGTERM");
    const forceKill = setTimeout(() => kill("SIGKILL"), 1000);
    try {
      await this.exit;
      // The sandbox wrapper can exit before its Playwright child.
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

/**
 * Claude Code shares an MCP server across agents, while Codex starts one per thread.
 * This loopback MCP endpoint gives each calling agent its own Playwright process,
 * identified through the PreToolUse hook's tool-use ID.
 */
export class BrowserProxy {
  private browsers = new Map<string, PlaywrightProcess>();
  private callers = new Map<string, string>();
  private tools: Promise<unknown> | undefined;
  private closing = false;
  private server = createServer();
  private endpoint = `/${randomUUID()}`;

  constructor(private launch: BrowserLaunch) {}

  /** Record which agent issued a tool call; the hook runs before the MCP request. */
  assign(toolUseId: string, agentId: string | undefined) {
    this.callers.set(toolUseId, agentId ?? PARENT);
  }

  /** Close a finished subagent's browser so idle sessions stop accruing cost. */
  async release(agentId: string) {
    const browser = this.browsers.get(agentId);
    this.browsers.delete(agentId);
    await browser?.close();
  }

  async start() {
    this.server.on("request", async (request, response) => {
      if (request.url !== this.endpoint || request.method !== "POST") {
        response.writeHead(request.url === this.endpoint ? 405 : 404).end();
        return;
      }
      let id: string | number | undefined;
      try {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const message = RequestSchema.parse(JSON.parse(body));
        id = message.id;
        if (id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result = await this.handle(message.method, message.params);
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32603, message: String(err) },
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing browser proxy address.");
    return `http://127.0.0.1:${address.port}${this.endpoint}`;
  }

  async close() {
    this.closing = true;
    if (this.server.listening) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        this.server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((browser) => browser.close()));
  }

  private async handle(method: string, params: unknown) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "playwright", version: "1.0.0" },
          instructions:
            "Each agent, including each subagent, gets its own separate browser.",
        };
      case "ping":
        return {};
      case "tools/list": {
        // Listing does not open a page; the broker allocates a session on first browser use.
        this.tools ??= this.browser(PARENT)
          .call("tools/list", {})
          .catch((err: unknown) => {
            this.tools = undefined;
            throw err;
          });
        const list = ToolListSchema.parse(await this.tools);
        return {
          ...list,
          tools: list.tools.filter(
            (tool) => !this.launch.disabledTools.includes(tool.name),
          ),
        };
      }
      case "tools/call": {
        const call = CallSchema.parse(params);
        if (this.launch.disabledTools.includes(call.name))
          throw new Error(`Unknown tool: ${call.name}`);
        const toolUseId = call._meta?.["claudecode/toolUseId"];
        const agent = (toolUseId && this.callers.get(toolUseId)) ?? PARENT;
        if (toolUseId) this.callers.delete(toolUseId);
        return this.browser(agent).call("tools/call", {
          name: call.name,
          arguments: call.arguments ?? {},
        });
      }
      default:
        throw new Error(`Unsupported MCP method: ${method}`);
    }
  }

  private browser(agent: string) {
    if (this.closing) throw new Error("The browser is shutting down.");
    let browser = this.browsers.get(agent);
    // A crashed Playwright process is replaced, so one failure does not end that agent's testing.
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
