import { randomUUID } from "node:crypto";
import { IncomingMessage, createServer } from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { z } from "zod";

const VersionSchema = z.object({ webSocketDebuggerUrl: z.url() });

/**
 * A local CDP port for agent-browser that gives every session its own browser.
 *
 * A new agent-browser session reads /json/version from its --cdp port, then
 * connects to the returned WebSocket path on that same port, whatever host the
 * response names. So each /json/version request takes a new browser from the
 * Browserbase supervisor and answers with a local path, and connections to that
 * path are piped to the browser.
 */
export async function startBrowserbaseRelay(supervisor: string) {
  const browsers = new Map<string, URL>();

  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || !request.url?.startsWith("/json/version")) {
      response.writeHead(404).end();
      return;
    }
    try {
      const browser = await newBrowser(supervisor);
      const id = `/${randomUUID()}`;
      browsers.set(id, browser);
      const local = `ws://127.0.0.1:${request.socket.localPort}${id}`;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ webSocketDebuggerUrl: local }));
    } catch {
      response.writeHead(502).end();
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const browser = browsers.get(request.url ?? "");
    if (browser) pipeWebSocket(request, socket, head, browser);
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing Browserbase relay address.");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function newBrowser(supervisor: string) {
  const response = await fetch(new URL("json/version/", supervisor), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new URL(
    VersionSchema.parse(await response.json()).webSocketDebuggerUrl,
  );
}

/** Replays the WebSocket handshake to the browser, then pipes both ways. */
function pipeWebSocket(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  browser: URL,
) {
  // Browserbase uses wss; a recorded local Chromium uses ws.
  const secure = browser.protocol === "wss:";
  const upstream = secure
    ? tls.connect({
        host: browser.hostname,
        port: Number(browser.port) || 443,
        servername: browser.hostname,
      })
    : net.connect({ host: browser.hostname, port: Number(browser.port) || 80 });
  const headers = [`Host: ${browser.host}`];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() !== "host")
      headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
  upstream.once(secure ? "secureConnect" : "connect", () => {
    upstream.write(
      `GET ${browser.pathname}${browser.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
}
