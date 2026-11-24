import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";

import { BrowserbaseSessions } from "../codex/browserbase";
import type { CodingAgentSettings } from "../coding-agent";
import { ANSWER_DOMAINS } from "../testing-browser";
import { AgentContext, AgentResults, EvalAgent } from "../types";
import {
  CONFIG_FILE,
  DriverConfig,
  ReplySchema,
  onMessage,
  sendMessage,
} from "./control";
import { SandboxRuntime } from "./runtime";

/** The harness's side of a containerized run: forwards EvalAgent calls to the driver. */
export class ContainerAgent implements EvalAgent {
  readonly preparesEnvironment = true;
  private runtime: SandboxRuntime | undefined;
  private broker: BrowserbaseSessions | undefined;
  private socket: Duplex | undefined;
  private nextId = 1;
  private calls = new Map<
    number,
    { resolve(result: unknown): void; reject(err: Error): void }
  >();
  private completion = Promise.withResolvers<void>();

  constructor(
    private context: AgentContext,
    private settings: CodingAgentSettings,
    private agent: { apiKey: string; apiHost: string },
  ) {
    // The run can fail before start returns completion to a listener.
    this.completion.promise.catch(() => {});
  }

  async start(
    message: string,
    signal: AbortSignal,
    _deadlineMs?: number,
    onReady?: () => number,
  ) {
    // Container startup counts toward the run's time, as Mo's sandbox startup does.
    onReady?.();
    const { context, settings, agent } = this;
    await mkdir(context.runDirectory, { recursive: true });
    const sessions = path.join(context.runDirectory, "browser-sessions");
    const broker =
      settings.browser === "local"
        ? undefined
        : await this.startBroker(sessions);
    const { targetUrl } = context;
    const runtime = await SandboxRuntime.start({
      runDirectory: context.runDirectory,
      reportDirectory: context.reportDirectory,
      readOnly: broker ? [sessions] : [],
      blocked: ANSWER_DOMAINS,
      rules: [
        { host: agent.apiHost, port: 443 },
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
    this.runtime = runtime;
    if (broker) await runtime.forward(Number(new URL(broker).port));
    const { fixture } = context;
    const config: DriverConfig = {
      settings,
      broker,
      context: {
        agentName: context.agentName,
        targetUrl: targetUrl?.href,
        timeLimitMs: context.timeLimitMs,
        reportDirectory: context.reportDirectory,
        runDirectory: context.runDirectory,
        // Not the whole fixture: its paths lead to labels.
        fixture: {
          name: fixture.name,
          username: fixture.username,
          password: fixture.password,
          additionalAccounts: fixture.additionalAccounts,
        },
      },
    };
    await writeFile(
      path.join(runtime.directory, CONFIG_FILE),
      JSON.stringify(config),
    );
    const connection = once(runtime, "control", { signal });
    const driver = runtime.exec(
      "node_modules/.bin/tsx",
      ["src/agents/sandbox/driver.ts"],
      { [agent.apiKey]: process.env[agent.apiKey] ?? "" },
    );
    const exited = once(driver, "exit").then(([code]) => {
      throw new Error(`The agent's container driver exited with code ${code}.`);
    });
    const [socket] = (await Promise.race([connection, exited])) as [Duplex];
    this.socket = socket;
    onMessage(socket, (reply) => this.receive(reply));
    socket.on("error", () => socket.destroy());
    socket.on("close", () =>
      this.fail(new Error("The agent's container driver exited.")),
    );
    await this.call({ method: "start", message }, signal);
    return { completion: this.completion.promise };
  }

  send(message: string, signal: AbortSignal) {
    return this.call({ method: "send", message }, signal).then(() => {});
  }

  async terminate() {
    try {
      if (this.socket) await this.call({ method: "terminate" });
    } finally {
      await this.broker?.stop();
    }
  }

  async collectResults(signal: AbortSignal) {
    try {
      const browserCost = await this.broker?.cost();
      return (await this.call(
        { method: "collectResults", browserCost },
        signal,
      )) as AgentResults;
    } finally {
      this.socket?.destroy();
      await this.runtime?.close();
    }
  }

  private async startBroker(directory: string) {
    const { context, settings } = this;
    if (!context.targetUrl)
      throw new Error("Browserbase runs need the fixture URL.");
    this.broker = new BrowserbaseSessions(
      directory,
      process.env.BROWSERBASE_API_KEY || "",
      {
        allowedDomains: [context.targetUrl.hostname],
        // Shared agent-browser sessions must survive disconnects.
        keepAlive: settings.browserTool === "agent-browser",
        timeoutSeconds: Math.min(
          21600,
          Math.ceil((context.timeLimitMs ?? 120 * 60_000) / 1000) + 120,
        ),
      },
    );
    return this.broker.start();
  }

  private call(
    request: { method: string; [field: string]: unknown },
    signal?: AbortSignal,
  ) {
    const { socket } = this;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("The agent's container isn't running."));
    signal?.throwIfAborted();
    const id = this.nextId++;
    signal?.addEventListener(
      "abort",
      () => sendMessage(socket, { cancel: id }),
      { once: true },
    );
    const result = new Promise<unknown>((resolve, reject) =>
      this.calls.set(id, { resolve, reject }),
    );
    sendMessage(socket, { id, ...request });
    return result;
  }

  private receive(message: unknown) {
    const reply = ReplySchema.parse(message);
    if ("completed" in reply) {
      if (reply.error) this.completion.reject(new Error(reply.error));
      else this.completion.resolve();
      return;
    }
    const call = this.calls.get(reply.id);
    this.calls.delete(reply.id);
    if (reply.error) call?.reject(new Error(reply.error));
    else call?.resolve(reply.result);
  }

  private fail(err: Error) {
    for (const call of this.calls.values()) call.reject(err);
    this.calls.clear();
    this.completion.reject(err);
  }
}
