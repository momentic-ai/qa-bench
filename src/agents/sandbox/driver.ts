// Runs inside the run's container: builds the agent from the harness's config and
// answers its EvalAgent calls over the control channel.
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { ClaudeAgent } from "../claude/claude-agent";
import { CodexAgent } from "../codex/codex-agent";
import {
  CONFIG_FILE,
  CONTROL_PORT,
  DriverConfig,
  RequestSchema,
  errorMessage,
  onMessage,
  sendMessage,
} from "./control";
import { CONTAINER_DIRECTORY } from "./runtime";

const config: DriverConfig = JSON.parse(
  await readFile(path.join(CONTAINER_DIRECTORY, CONFIG_FILE), "utf8"),
);
const { targetUrl, ...context } = config.context;
const Agent = config.settings.family === "codex" ? CodexAgent : ClaudeAgent;
const agent = Agent.create(
  {
    ...context,
    targetUrl: targetUrl ? new URL(targetUrl) : undefined,
  },
  config.settings,
  config.broker,
);

const socket = connect(CONTROL_PORT, "127.0.0.1");
// The harness closes the channel when it's done with the run.
socket.on("close", () => process.exit(0));
// Kept after a call returns: start's signal governs the running agent.
const signals = new Map<number, AbortController>();

onMessage(socket, async (message) => {
  const request = RequestSchema.parse(message);
  if ("cancel" in request) {
    signals.get(request.cancel)?.abort(new Error("Cancelled by the harness."));
    return;
  }
  const controller = new AbortController();
  signals.set(request.id, controller);
  const { signal } = controller;
  try {
    let result: unknown = null;
    if (request.method === "start") {
      const execution = await agent.start(request.message, signal);
      execution.completion.then(
        () => sendMessage(socket, { completed: true }),
        (err: unknown) =>
          sendMessage(socket, { completed: true, error: errorMessage(err) }),
      );
    } else if (request.method === "send") {
      await agent.send(request.message, signal);
    } else if (request.method === "terminate") {
      await agent.terminate();
    } else if (request.method === "collectResults") {
      result = await agent.collectResults(signal, request.browserCost);
    }
    sendMessage(socket, { id: request.id, result });
  } catch (err) {
    sendMessage(socket, { id: request.id, error: errorMessage(err) });
  }
});
