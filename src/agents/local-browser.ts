import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const playwright = createRequire(
  createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
);

const PlaywrightSchema = z.object({
  chromium: z.custom<{ executablePath(): string }>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "executablePath" in value &&
      typeof value.executablePath === "function",
  ),
});

function chromiumExecutable() {
  return PlaywrightSchema.parse(
    playwright("playwright-core"),
  ).chromium.executablePath();
}

export function localBrowserConnection() {
  const executablePath = chromiumExecutable();
  return {
    args: [
      "--browser",
      "chromium",
      "--headless",
      "--executable-path",
      executablePath,
    ],
    env: {},
    filesystem: { [path.dirname(path.dirname(executablePath))]: "read" },
  };
}

function running(child: ChildProcess | undefined): child is ChildProcess {
  return child?.exitCode === null && child.signalCode === null;
}

/** Asks Chromium to quit over CDP. */
async function closeBrowser(webSocketUrl: string) {
  const socket = new WebSocket(webSocketUrl);
  await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
}

/**
 * A headless Chromium with a debugging port, which the agent's tool and the
 * bug-video recorder both connect to.
 */
export class LocalChromium {
  private process: ChildProcess | undefined;
  private profile: string | undefined;
  private webSocketUrl: string | undefined;

  constructor(private onStart: (webSocketUrl: string) => void) {}

  /** Launches the browser and returns its CDP endpoint. */
  async start() {
    this.profile = await mkdtemp(path.join(tmpdir(), "qa-bench-chromium-"));
    this.process = spawn(
      chromiumExecutable(),
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let failed: Error | undefined;
    this.process.once("error", (err) => (failed = err));
    // Chromium writes its chosen port and browser path here once it listens.
    const portFile = path.join(this.profile, "DevToolsActivePort");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed) throw failed;
      if (!running(this.process))
        throw new Error("Local Chromium exited on start.");
      const [port, browserPath] = (
        await readFile(portFile, "utf8").catch(() => "")
      ).split("\n");
      if (browserPath) {
        this.webSocketUrl = `ws://127.0.0.1:${port}${browserPath}`;
        this.onStart(this.webSocketUrl);
        return `http://127.0.0.1:${port}/`;
      }
      await delay(100);
    }
    throw new Error("Local Chromium did not start.");
  }

  /** A local browser has no hosting cost. */
  async cost() {
    return undefined;
  }

  async stop() {
    const child = this.process;
    if (running(child)) {
      const exited = once(child, "exit");
      // A clean shutdown waits for Chromium's helper processes, which still
      // write to the profile after a SIGTERM.
      const closed = this.webSocketUrl
        ? closeBrowser(this.webSocketUrl)
        : Promise.reject(new Error("Local Chromium did not start."));
      await closed.catch(() => child.kill());
      const timeout = AbortSignal.timeout(10_000);
      await Promise.race([exited, once(timeout, "abort")]);
      if (running(child)) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    if (this.profile)
      await rm(this.profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function validateLocalChromium() {
  const executable = chromiumExecutable();
  try {
    await access(executable);
  } catch {
    throw new Error(
      `Local Chromium is missing at ${executable}. Install it with: node ${path.join(path.dirname(playwright.resolve("playwright-core/package.json")), "cli.js")} install --with-deps chromium`,
    );
  }
}
