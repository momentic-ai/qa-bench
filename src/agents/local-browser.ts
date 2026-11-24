import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
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

type Chromium = { child: ChildProcess; profile: string; webSocketUrl?: string };

/** Launches a headless Chromium with a debugging port. */
async function launchChromium(browsers: Chromium[]) {
  const executable = chromiumExecutable();
  const profile = await mkdtemp(path.join(tmpdir(), "qa-bench-chromium-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const browser: Chromium = { child, profile };
  browsers.push(browser);
  let failed: Error | undefined;
  child.once("error", (err) => (failed = err));
  // Chromium writes its chosen port and browser path here once it listens.
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failed) throw failed;
    if (!running(child)) throw new Error("Local Chromium exited on start.");
    const [port, browserPath] = (
      await readFile(portFile, "utf8").catch(() => "")
    ).split("\n");
    if (browserPath) {
      browser.webSocketUrl = `ws://127.0.0.1:${port}${browserPath}`;
      return browser.webSocketUrl;
    }
    await delay(100);
  }
  throw new Error("Local Chromium did not start.");
}

async function stopChromium({ child, profile, webSocketUrl }: Chromium) {
  if (running(child)) {
    const exited = once(child, "exit");
    // A clean shutdown waits for Chromium's helper processes, which still
    // write to the profile after a SIGTERM.
    const closed = webSocketUrl
      ? closeBrowser(webSocketUrl)
      : Promise.reject(new Error("Local Chromium did not start."));
    await closed.catch(() => child.kill());
    const timeout = AbortSignal.timeout(10_000);
    await Promise.race([exited, once(timeout, "abort")]);
    if (running(child)) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * A local CDP endpoint that launches a new headless Chromium for each
 * connection, like the Browserbase broker. The agent's tool and the bug-video
 * recorder both connect to each one.
 */
export class LocalChromium {
  private browsers: Chromium[] = [];
  private server = createServer();
  private route = `/${randomUUID()}/json/version/`;
  private launches = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(private onStart: (webSocketUrl: string) => void) {}

  /** Starts the endpoint and returns its URL. */
  async start() {
    this.server.on("request", async (request, response) => {
      if (request.method !== "GET" || request.url !== this.route) {
        response.writeHead(404).end();
        return;
      }
      if (this.stopping) {
        response.writeHead(503).end();
        return;
      }
      const launch = launchChromium(this.browsers);
      this.launches.add(launch);
      try {
        const webSocketUrl = await launch;
        if (this.stopping) throw new Error("Local Chromium is stopping.");
        this.onStart(webSocketUrl);
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ webSocketDebuggerUrl: webSocketUrl }));
      } catch (err) {
        response.writeHead(502).end(String(err));
      } finally {
        this.launches.delete(launch);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local Chromium address.");
    return `http://127.0.0.1:${address.port}${this.route.replace(/json\/version\/$/, "")}`;
  }

  /** A local browser has no hosting cost. */
  async cost() {
    return undefined;
  }

  async stop() {
    this.stopping = true;
    this.server.close();
    await Promise.allSettled(this.launches);
    await Promise.all(this.browsers.map(stopChromium));
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
