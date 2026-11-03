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
        thread: z.object({ id: z.string() }).passthrough().optional(),
        turnId: z.string().nullish(),
        turn: TurnSchema.nullish(),
        goal: z.object({ status: z.string() }).passthrough().nullish(),
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
// Codex app-server rejects longer goal objectives (JSON-RPC -32600).
export const GOAL_OBJECTIVE_MAX_LENGTH = 4000;

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
      // Server requests also have IDs; route them before matching client replies.
      const task = this.answerRequest(
        message.id,
        message.method,
        message.params,
      ).catch((err: unknown) => this.fail(err));
      this.toolCalls.push(task);
      return;
    }
    if (typeof message.id === "number") {
      // Ordinary replies settle the matching client request.
      const pending = this.pending.get(message.id);
      if (!pending) {
        // Aborted requests may still receive late replies from the subprocess.
        return;
      }
      if (message.error !== undefined) {
        // RPC failures must remain visible, including rejected steering.
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        // Callers validate their method-specific response shape.
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) {
      // Only method-bearing envelopes can be execution notifications.
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
      // One execution loop consumes events; message delivery only sends RPCs.
      const waiter = this.notificationWaiter;
      this.notificationWaiter = null;
      waiter.resolve(notification);
    } else {
      // Startup may emit events before the execution loop begins.
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
      // Reject unsupported requests instead of leaving the agent waiting forever.
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
      // A broken transport cannot accept additional RPCs.
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
            // A failed pipe write settles the request without waiting for its timeout.
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
      // Preserve arrival order for events emitted during startup.
      return Promise.resolve(notification);
    }
    if (this.failure !== undefined) {
      // Transport failure must wake completion even without another notification.
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

  /** The full task goes in the first turn; the goal objective is a short pointer to it. */
  async startGoal({
    threadId,
    task,
    objective,
    signal,
    persistent = true,
  }: {
    threadId: string;
    task: string;
    objective: string;
    signal: AbortSignal;
    persistent?: boolean;
  }) {
    if (objective.length > GOAL_OBJECTIVE_MAX_LENGTH) {
      throw new Error(
        `Codex goal objectives are limited to ${GOAL_OBJECTIVE_MAX_LENGTH} characters.`,
      );
    }
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
    if (persistent) {
      await this.request("thread/goal/set", { threadId, objective }, signal);
    }
  }

  async waitForCompletion(
    threadId: string,
    signal: AbortSignal,
    onEvent: (event: CodexNotification) => void | Promise<void>,
    requireGoal = true,
  ) {
    let goalCompleted = false;
    let turnCompleted = false;
    for (;;) {
      const notification = await this.nextNotification(signal);
      if (this.failure !== undefined) throw this.failure;
      await onEvent(notification);
      if (
        notification.params?.threadId === threadId &&
        notification.method === "thread/goal/updated"
      ) {
        // The parent owns the goal; child progress must not mark it complete.
        goalCompleted = notification.params.goal?.status === "complete";
      }
      if (notification.params?.threadId === threadId) {
        if (notification.method === "turn/started") turnCompleted = false;
        if (notification.method === "turn/completed") turnCompleted = true;
      }
      if (this.failure !== undefined) {
        // A later failure can already be known while earlier events remain queued.
        throw this.failure;
      }
      if (
        (requireGoal ? goalCompleted : turnCompleted) &&
        this.pendingMessages === 0 &&
        this.activeTurns.size === 0 &&
        this.notifications.length === 0
      ) {
        // Goal completion alone is insufficient: parent and observed children must finish.
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
            // Steer in place to retain accepted findings and child conversations.
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
            // An idle parent needs a new turn to receive the instruction.
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
            // Retry only a changed turn precondition, never unrelated provider failures.
            throw err;
          }
          // Retry a rejected RPC only if its active-turn precondition changed.
        }
      }
    } finally {
      this.pendingMessages -= 1;
      // A turn may finish before its steer RPC resolves; wake the completion waiter again.
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
        // Windows targets the leader only; Unix groups can outlive their leader.
        return;
      }
      try {
        if (this.child.pid && process.platform !== "win32") {
          // Subagents and MCP subprocesses share this eval's process group.
          process.kill(-this.child.pid, signal);
        } else {
          // Windows supports stopping the app-server process directly.
          this.child.kill(signal);
        }
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) {
          // A process that just exited is harmless; permission and other failures are not.
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
