#!/usr/bin/env node
import { spawn } from "node:child_process";

const endpoint = process.env.QA_BENCH_BROWSER_BROKER;
const agentId =
  process.env.QA_BENCH_BROWSER_AGENT_ID || process.env.CODEX_THREAD_ID;
const args = process.argv.slice(2);
// Browser selection belongs to the harness, including when the CLI is restarted.
const override = args.find((arg) =>
  /^(?:-p|--(?:config|cdp|executable-path|profile|provider|auto-connect|namespace|engine|browser))(?:=|$)/.test(
    arg,
  ),
);
const valueOptions = new Set([
  "--session",
  "--session-name",
  "--restore-save",
  "--restore-check-url",
  "--restore-check-text",
  "--restore-check-fn",
  "--state",
  "--headers",
  "--extension",
  "--init-script",
  "--enable",
  "--args",
  "--user-agent",
  "--proxy",
  "--proxy-bypass",
  "--ca-cert",
  "--hide-scrollbars",
  "--device",
  "--screenshot-dir",
  "--screenshot-quality",
  "--screenshot-format",
  "--input-mode",
  "--color-scheme",
  "--download-path",
  "--max-output",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
]);
let commandIndex = 0;
while (args[commandIndex]?.startsWith("-")) {
  const option = args[commandIndex];
  commandIndex += valueOptions.has(option) ? 2 : 1;
}
const connectionCommand = ["connect", "install", "upgrade"].includes(
  args[commandIndex],
);

async function request(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      "Browser ownership/allocation failed; local fallback is disabled.",
    );
  return response.json();
}

try {
  if (!endpoint || !agentId)
    throw new Error(
      "Missing harness browser owner; local fallback is disabled.",
    );
  if (override || connectionCommand) {
    await request({
      action: "violation",
      reason: "Browser connection/configuration override rejected.",
    });
    throw new Error(
      "The harness owns browser configuration. Connection/configuration overrides are disabled.",
    );
  }
  const { command, env } = await request({ action: "environment" });
  if (
    typeof command !== "string" ||
    !env ||
    typeof env.AGENT_BROWSER_CONFIG !== "string" ||
    typeof env.AGENT_BROWSER_SOCKET_DIR !== "string" ||
    typeof env.AGENT_BROWSER_SCREENSHOT_DIR !== "string" ||
    typeof env.AGENT_BROWSER_NAMESPACE !== "string"
  ) {
    throw new Error("Invalid harness browser environment.");
  }
  const childEnv = { ...process.env };
  // These options can otherwise redirect a new daemon outside the owned browser.
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith("AGENT_BROWSER_") &&
      ![
        "AGENT_BROWSER_SESSION",
        "AGENT_BROWSER_DEFAULT_TIMEOUT",
        "AGENT_BROWSER_NO_AUTO_DIALOG",
      ].includes(key)
    )
      delete childEnv[key];
  }
  const child = spawn(process.execPath, [command, ...args], {
    env: { ...childEnv, ...env },
    stdio: "inherit",
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", () => {
    process.stderr.write("Could not start the owned browser CLI.\n");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Browser wrapper failed."}\n`,
  );
  process.exitCode = 1;
}
