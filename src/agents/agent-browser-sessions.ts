import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { writeJson } from "../evals/json-file";

const exec = promisify(execFile);
const RequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("environment"),
    agentId: z.string().min(1).max(160),
  }),
  z.object({
    action: z.literal("violation"),
    agentId: z.string().min(1).max(160),
    reason: z.string().max(200),
  }),
]);

export type BrowserAllocation = { id: string; connectUrl: string };
export type AgentBrowserProvider = {
  create(agentId: string): Promise<BrowserAllocation>;
  releaseAgent(agentId: string): Promise<void>;
};
type Owner = {
  agentId: string;
  config: string;
  socketDirectory: string;
  screenshotDirectory: string;
  allocation?: BrowserAllocation;
};

/** A CLI session name is only an alias within one agent's browser ownership. */
export class AgentBrowserSessions {
  private server = createServer();
  private route = `/${randomUUID()}`;
  private owners = new Map<string, Promise<Owner>>();
  private registered = new Set<string>();
  private releasing = new Map<string, Promise<void>>();
  private closing = false;
  private socketRoot = "";
  private events: {
    agentId: string;
    event: string;
    sessionId?: string;
    reason?: string;
  }[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private workspace: string,
    private command: string,
    private reportDirectory: string,
    private provider?: AgentBrowserProvider,
    private executablePath?: string,
  ) {}

  register(agentId: string) {
    if (!this.closing) this.registered.add(agentId);
  }

  async start() {
    if (!this.provider && !this.executablePath)
      throw new Error("Missing owned browser provider.");
    this.socketRoot = await mkdtemp(path.join(tmpdir(), "qa-bs-"));
    this.server.on("request", async (request, response) => {
      if (
        this.closing ||
        request.method !== "POST" ||
        request.url !== this.route
      ) {
        response.writeHead(404).end();
        return;
      }
      try {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 4096)
            throw new Error("Browser request is too large.");
        }
        const call = RequestSchema.parse(JSON.parse(body));
        // Native child startup notifications can arrive just behind its first shell call.
        for (
          let attempt = 0;
          !this.registered.has(call.agentId) && attempt < 100 && !this.closing;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (this.closing || !this.registered.has(call.agentId))
          throw new Error("Unknown browser owner.");
        if (call.action === "violation") {
          await this.record({
            agentId: call.agentId,
            event: "rejected-override",
            reason: call.reason,
          });
          response.writeHead(200).end("{}");
          return;
        }
        const owner = await this.owner(call.agentId);
        if (this.closing || !this.registered.has(call.agentId))
          throw new Error("Browser owner stopped.");
        // Restore the owned endpoint even if an agent edited a config file between calls.
        await writeJson(
          owner.config,
          owner.allocation
            ? { cdp: owner.allocation.connectUrl }
            : { executablePath: this.executablePath },
        );
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            command: this.command,
            env: this.environment(owner),
          }),
        );
      } catch {
        // Provider errors may contain CDP credentials; keep them out of tool output.
        response
          .writeHead(502)
          .end(
            "Browser ownership/allocation failed; no local fallback was started.",
          );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Browser broker address missing.");
    return `http://127.0.0.1:${address.port}${this.route}`;
  }

  private async owner(agentId: string) {
    await this.releasing.get(agentId);
    if (this.closing) throw new Error("Browser broker is closing.");
    let owner = this.owners.get(agentId);
    if (!owner) {
      owner = this.createOwner(agentId);
      this.owners.set(agentId, owner);
      const current = owner;
      void owner.catch(() => {
        if (this.owners.get(agentId) === current) this.owners.delete(agentId);
      });
    }
    return owner;
  }

  private async createOwner(agentId: string): Promise<Owner> {
    const key = createHash("sha256")
      .update(`${agentId}:${randomUUID()}`)
      .digest("hex")
      .slice(0, 16);
    const directory = path.join(this.workspace, ".browser-owners", key);
    const owner: Owner = {
      agentId,
      config: path.join(directory, "agent-browser.json"),
      socketDirectory: path.join(this.socketRoot, key),
      screenshotDirectory: path.join(this.workspace, "browser-artifacts", key),
    };
    await Promise.all(
      [directory, owner.socketDirectory, owner.screenshotDirectory].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    try {
      owner.allocation = await this.provider?.create(agentId);
      await this.record({
        agentId,
        event: "allocated",
        ...(owner.allocation ? { sessionId: owner.allocation.id } : {}),
      });
      return owner;
    } catch {
      await this.provider?.releaseAgent(agentId);
      await this.record({ agentId, event: "allocation-failed" });
      throw new Error("Browser allocation failed.");
    }
  }

  private environment(owner: Owner) {
    return {
      AGENT_BROWSER_CONFIG: owner.config,
      AGENT_BROWSER_SOCKET_DIR: owner.socketDirectory,
      AGENT_BROWSER_SCREENSHOT_DIR: owner.screenshotDirectory,
      AGENT_BROWSER_NAMESPACE: createHash("sha256")
        .update(owner.config)
        .digest("hex")
        .slice(0, 16),
    };
  }

  release(agentId: string) {
    this.registered.delete(agentId);
    const owner = this.owners.get(agentId);
    this.owners.delete(agentId);
    const previous = this.releasing.get(agentId);
    if (!owner) return previous ?? Promise.resolve();
    const work = (async () => {
      try {
        await previous?.catch(() => {});
        if (owner) {
          const resource = await owner;
          await exec(process.execPath, [this.command, "close", "--all"], {
            env: {
              HOME: process.env.HOME,
              PATH: process.env.PATH,
              ...this.environment(resource),
            },
            timeout: 30_000,
          });
        }
      } catch {
        await this.record({ agentId, event: "cleanup-failed" });
        throw new Error("Owned browser CLI cleanup failed.");
      } finally {
        await this.provider?.releaseAgent(agentId);
        await this.record({ agentId, event: "released" });
      }
    })();
    this.releasing.set(agentId, work);
    return work;
  }

  async close() {
    this.closing = true;
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) =>
        this.server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    const results = await Promise.allSettled(
      [...this.owners.keys()].map((agentId) => this.release(agentId)),
    );
    const releases = await Promise.allSettled(this.releasing.values());
    try {
      await this.writes;
    } finally {
      if (this.socketRoot)
        await rm(this.socketRoot, { recursive: true, force: true });
    }
    const failure = [...results, ...releases].find(
      (result) => result.status === "rejected",
    );
    if (failure?.status === "rejected") throw failure.reason;
  }

  private record(event: (typeof this.events)[number]) {
    this.events.push(event);
    this.writes = this.writes.then(() =>
      writeJson(path.join(this.reportDirectory, "browser-ownership.json"), {
        provider: this.provider ? "browserbase" : "local",
        events: this.events,
      }),
    );
    return this.writes;
  }
}
