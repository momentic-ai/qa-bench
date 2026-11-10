import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  BrowserSessionCost,
  browserCost,
  browserCostError,
  kernelSessionCost,
} from "../../evals/browser-cost";
import { writeJson } from "../../evals/json-file";

const SessionSchema = z.object({
  session_id: z.string(),
  cdp_ws_url: z.url(),
});

// Each MCP process requests its own CDP endpoint. The supervisor records every
// allocation before returning it, including child agents and replacement browsers.
export class KernelSessions {
  private sessions = new Set<string>();
  private pending = new Set<Promise<void>>();
  private errors: string[] = [];
  private closing = false;
  private server = createServer();
  private route = `/${randomUUID()}/json/version/`;

  constructor(
    private directory: string,
    private apiKey: string,
    private options: {
      /** Kernel refuses every other destination, including subresources. */
      allowedHosts?: string[];
      /** Kernel deletes a browser after this long without CDP activity. */
      timeoutSeconds: number;
    },
    private baseUrl = "https://api.onkernel.com",
  ) {}

  private async request(
    resource: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: unknown,
  ) {
    const response = await fetch(`${this.baseUrl}${resource}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`KERNEL_HTTP_${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  async start() {
    this.server.on("request", (request, response) => {
      if (
        this.closing ||
        request.method !== "GET" ||
        request.url !== this.route
      ) {
        // Only the unguessable CDP discovery route can allocate paid browsers.
        response.writeHead(404).end();
        return;
      }
      const work = (async () => {
        try {
          const session = SessionSchema.parse(
            await this.request("/browsers", "POST", {
              headless: true,
              timeout_seconds: this.options.timeoutSeconds,
              tags: {
                qaBenchRun: path.basename(path.dirname(this.directory)),
              },
              ...(this.options.allowedHosts
                ? { network: { allowed_hosts: this.options.allowedHosts } }
                : {}),
            }),
          );
          this.sessions.add(session.session_id);
          await writeJson(
            path.join(this.directory, `${session.session_id}.json`),
            { id: session.session_id },
          );
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ webSocketDebuggerUrl: session.cdp_ws_url }));
        } catch (err) {
          // Provider/transport errors can contain credentials; persist a safe failure marker.
          this.errors.push(
            `KERNEL_ALLOCATION_FAILED_OR_UNKNOWN:${browserCostError(err)}`,
          );
          process.stderr.write(
            "Kernel allocation failed; browser cost may be incomplete.\n",
          );
          response.writeHead(502).end("Kernel allocation failed");
        }
      })();
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("KERNEL_BROKER_ADDRESS_MISSING");
    return `http://127.0.0.1:${address.port}${this.route.replace(/json\/version\/$/, "")}`;
  }

  async stop() {
    this.closing = true;
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
    await Promise.all(this.pending);
    await Promise.all(
      [...this.sessions].map(async (id) => {
        try {
          await this.request(`/browsers/${id}`, "DELETE");
        } catch (err) {
          // A browser that already hit its idle timeout is gone; usage still reads.
          if (err instanceof Error && err.message === "KERNEL_HTTP_404") return;
          this.errors.push(
            `KERNEL_RELEASE_FAILED:${id}:${browserCostError(err)}`,
          );
        }
      }),
    );
  }

  async cost() {
    const sessions: BrowserSessionCost[] = [];
    await Promise.all(
      [...this.sessions].map(async (id) => {
        try {
          for (let attempt = 0; ; attempt++) {
            const usage = await this.request(
              `/browsers/${id}?include_deleted=true`,
            );
            try {
              const cost = kernelSessionCost(usage);
              if (cost.id !== id)
                throw new Error("KERNEL_USAGE_SESSION_MISMATCH");
              sessions.push(cost);
              await writeJson(path.join(this.directory, `${id}.json`), cost);
              break;
            } catch (err) {
              if (
                err instanceof Error &&
                err.message === "KERNEL_USAGE_NOT_READY" &&
                attempt < 29
              ) {
                // Final usage can lag a successful deletion.
                await delay(1000);
              } else {
                // Invalid usage and exhausted retries remain explicitly incomplete.
                throw err;
              }
            }
          }
        } catch (err) {
          this.errors.push(
            `KERNEL_USAGE_UNAVAILABLE:${id}:${browserCostError(err)}`,
          );
        }
      }),
    );
    const result = browserCost("kernel", sessions, this.errors);
    if (result.errors.length)
      process.stderr.write(
        `Browser cost incomplete: ${result.errors.join(", ")}\n`,
      );
    return result;
  }
}
