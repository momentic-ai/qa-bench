import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

import { runCommand } from "../../evals/command";

const TurnSchema = z
  .object({ id: z.string(), status: z.string(), error: z.unknown().nullish() })
  .passthrough();
const TurnResponseSchema = z.object({ turn: TurnSchema }).passthrough();
const NotificationSchema = z
  .object({
    method: z.string(),
    params: z
      .object({
        threadId: z.string().nullish(),
        turnId: z.string().nullish(),
        turn: TurnSchema.nullish(),
        item: z
          .object({
            type: z.string(),
            text: z.string().optional(),
            server: z.string().optional(),
            tool: z.string().optional(),
            status: z.string().optional(),
            receiverThreadIds: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type CodexNotification = z.infer<typeof NotificationSchema>;
const EnvelopeSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
const ToolCallSchema = z.object({
  threadId: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});
type PendingRequest = {
  resolve(result: unknown): void;
  reject(err: unknown): void;
};
type NotificationWaiter = {
  resolve(message: CodexNotification): void;
  reject(err: unknown): void;
};

export function loginCodexWithApiKey(
  command: string,
  env: NodeJS.ProcessEnv,
  apiKey: string,
  signal: AbortSignal,
) {
  return runCommand(process.execPath, [command, "login", "--with-api-key"], {
    env,
    signal,
    input: `${apiKey}\n`,
  });
}

export class CodexAppServer {
  private child;
  private exit: Promise<void>;
  private exited = false;
  private closing: Promise<void> | undefined;
  private failure: unknown;
  private pending = new Map<number, PendingRequest>();
  private toolCalls: Promise<void>[] = [];
  private notifications: CodexNotification[] = [];
  private notificationWaiter: NotificationWaiter | null = null;
  private activeTurns = new Map<string, string>();
  private nextId = 1;
  private stderr = "";
  private pendingMessages = 0;
  private rootThreadId: string | undefined;

  constructor(
    command: string,
    env: NodeJS.ProcessEnv,
    private handleTool: (
      threadId: string,
      tool: string,
      args: unknown,
    ) => Promise<void>,
  ) {
    this.child = spawn(process.execPath, [command, "app-server", "--stdio"], {
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise((resolve) =>
      this.child.once("close", () => {
        this.exited = true;
        resolve();
      }),
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err) {
        this.fail(err);
      }
    });
    this.child.on("error", (err) => this.fail(err));
    this.child.stdin.on("error", (err) => this.fail(err));
    this.child.on("exit", (code) =>
      this.fail(new Error(`Codex app-server exited (${code}): ${this.stderr}`)),
    );
  }

  private handleMessage(value: unknown) {
    const message = EnvelopeSchema.parse(value);
    if (message.method && message.id !== undefined) {
      const task = this.answerRequest(
        message.id,
        message.method,
        message.params,
      ).catch((err: unknown) => this.fail(err));
      this.toolCalls.push(task);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      if (message.error !== undefined) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) {
      return;
    }
    const notification = NotificationSchema.parse(value);
    const threadId = notification.params?.threadId;
    if (threadId && notification.method === "turn/started") {
      // Track child turns too, so parent completion cannot abandon active work.
      this.activeTurns.set(
        threadId,
        TurnSchema.parse(notification.params?.turn).id,
      );
    }
    if (threadId && notification.method === "turn/completed") {
      this.activeTurns.delete(threadId);
      if (
        threadId === this.rootThreadId &&
        notification.params?.turn?.status === "failed"
      ) {
        this.fail(
          new Error(
            `Codex turn failed: ${JSON.stringify(notification.params.turn.error)}`,
          ),
        );
      }
    }
    this.enqueueNotification(notification);
  }

  private enqueueNotification(notification: CodexNotification) {
    if (this.notificationWaiter) {
      const waiter = this.notificationWaiter;
      this.notificationWaiter = null;
      waiter.resolve(notification);
    } else {
      this.notifications.push(notification);
    }
  }

  private async answerRequest(
    id: string | number,
    method: string,
    params: unknown,
  ) {
    if (method === "currentTime/read") {
      // The pinned protocol can delegate wall-clock reads to its host.
      await this.write({
        id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      });
      return;
    }
    if (method !== "item/tool/call") {
      await this.write({
        id,
        error: { code: -32601, message: `Unsupported eval request: ${method}` },
      });
      return;
    }
    let result;
    try {
      const call = ToolCallSchema.parse(params);
      await this.handleTool(call.threadId, call.tool, call.arguments);
      result = {
        success: true,
        contentItems: [
          { type: "inputText", text: "Saved to the evaluation results." },
        ],
      };
    } catch (err) {
      process.stderr.write(`Codex reporting tool failed: ${err}\n`);
      result = {
        success: false,
        contentItems: [{ type: "inputText", text: String(err) }],
      };
    }
    if (!this.exited) {
      // Persistence may finish during shutdown, after the transport has exited.
      await this.write({ id, result });
    }
  }

  private write(value: unknown) {
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private fail(err: unknown) {
    this.failure ??= err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this.notificationWaiter?.reject(err);
    this.notificationWaiter = null;
  }

  request(method: string, params: unknown, signal: AbortSignal) {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(120_000),
    ]);
    requestSignal.throwIfAborted();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(requestSignal.reason);
      };
      const finish = () => {
        requestSignal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      requestSignal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (err) => {
          finish();
          reject(err);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (err) => {
          if (err) {
            finish();
            reject(err);
          }
        },
      );
    });
  }

  private nextNotification(signal: AbortSignal): Promise<CodexNotification> {
    signal.throwIfAborted();
    const notification = this.notifications.shift();
    if (notification) {
      return Promise.resolve(notification);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.notificationWaiter = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.notificationWaiter = {
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
    });
  }

  async initialize(signal: AbortSignal) {
    await this.request(
      "initialize",
      {
        clientInfo: { name: "diy-mo", title: "DIY Mo", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      signal,
    );
    await this.write({ method: "initialized", params: {} });
  }

  async startTurn(threadId: string, task: string, signal: AbortSignal) {
    this.rootThreadId = threadId;
    TurnResponseSchema.parse(
      await this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: task, text_elements: [] }],
        },
        signal,
      ),
    );
  }

  async waitForCompletion(
    threadId: string,
    signal: AbortSignal,
    onEvent: (event: CodexNotification) => void | Promise<void>,
  ) {
    let turnCompleted = false;
    for (;;) {
      const notification = await this.nextNotification(signal);
      if (this.failure !== undefined) throw this.failure;
      await onEvent(notification);
      if (notification.params?.threadId === threadId) {
        if (notification.method === "turn/started") turnCompleted = false;
        if (notification.method === "turn/completed") turnCompleted = true;
      }
      if (this.failure !== undefined) {
        // A later failure can already be known while earlier events remain queued.
        throw this.failure;
      }
      if (
        turnCompleted &&
        this.pendingMessages === 0 &&
        this.activeTurns.size === 0 &&
        this.notifications.length === 0
      ) {
        return;
      }
    }
  }

  async sendMessage(threadId: string, message: string, signal: AbortSignal) {
    this.pendingMessages += 1;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const activeTurnId = this.activeTurns.get(threadId);
        try {
          if (activeTurnId) {
            await this.request(
              "turn/steer",
              {
                threadId,
                expectedTurnId: activeTurnId,
                input: [{ type: "text", text: message, text_elements: [] }],
              },
              signal,
            );
          } else {
            TurnResponseSchema.parse(
              await this.request(
                "turn/start",
                {
                  threadId,
                  input: [{ type: "text", text: message, text_elements: [] }],
                },
                signal,
              ),
            );
          }
          return;
        } catch (err) {
          signal.throwIfAborted();
          if (attempt > 0 || this.activeTurns.get(threadId) === activeTurnId) {
            throw err;
          }
        }
      }
    } finally {
      this.pendingMessages -= 1;
      this.enqueueNotification({ method: "eval/messageDelivered" });
    }
  }

  close() {
    this.closing ??= this.closeHelper();
    return this.closing;
  }

  private async closeHelper() {
    const kill = (signal: NodeJS.Signals) => {
      if (this.exited && process.platform === "win32") {
        return;
      }
      try {
        if (this.child.pid && process.platform !== "win32") {
          // Subagents and MCP subprocesses share this eval's process group.
          process.kill(-this.child.pid, signal);
        } else {
          this.child.kill(signal);
        }
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) {
          throw err;
        }
      }
    };
    kill("SIGTERM");
    const forceKill = setTimeout(() => kill("SIGKILL"), 1000);
    try {
      await this.exit;
      // MCP descendants may ignore SIGTERM and close their pipes before the leader exits.
      kill("SIGKILL");
      await Promise.all(this.toolCalls);
    } finally {
      clearTimeout(forceKill);
    }
  }
}
