#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const owner =
  process.env.QA_BENCH_BROWSER_AGENT_ID || process.env.CODEX_THREAD_ID;
if (!owner) throw new Error("Missing native browser agent identity.");
const namespace = createHash("sha256")
  .update(`${process.env.AGENT_BROWSER_CONFIG}:${owner}`)
  .digest("hex")
  .slice(0, 16);
const sockets = path.join(process.env.AGENT_BROWSER_SOCKET_DIR, namespace);
const screenshots = path.join(
  process.env.AGENT_BROWSER_SCREENSHOT_DIR,
  namespace,
);
for (const directory of [sockets, screenshots])
  mkdirSync(directory, { recursive: true });
const child = spawn(
  process.execPath,
  [process.env.QA_BENCH_BROWSER_COMMAND, ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      AGENT_BROWSER_NAMESPACE: namespace,
      AGENT_BROWSER_SOCKET_DIR: sockets,
      AGENT_BROWSER_SCREENSHOT_DIR: screenshots,
    },
    stdio: "inherit",
  },
);
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
