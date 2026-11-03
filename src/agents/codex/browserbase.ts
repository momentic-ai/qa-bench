import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  BrowserSessionCost,
  browserCost,
  browserCostError,
  browserbaseSessionCost,
} from "../../evals/browser-cost";
import { writeJson } from "../../evals/json-file";

const SessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  connectUrl: z.url(),
});

export function sessionRequest(
  directory: string,
  allowedDomains?: string[],
  timeoutSeconds?: number,
  keepAlive = false,
) {
  return {
    userMetadata: { moEvalRun: path.basename(path.dirname(directory)) },
    ...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
    ...(keepAlive ? { keepAlive: true } : {}),
    ...(allowedDomains ? { browserSettings: { allowedDomains } } : {}),
  };
}

// Each MCP process requests its own CDP endpoint. The supervisor records every
// allocation before returning it, including child agents and replacement browsers.
export class BrowserbaseSessions {
  private sessions = new Map<string, string>();
  private pending = new Set<Promise<void>>();
  private errors: string[] = [];
  private closing = false;
  private server = createServer();
  private route = `/${randomUUID()}/json/version/`;

  private baseUrl: string;
  private allowedDomains: string[] | undefined;
  private timeoutSeconds: number | undefined;
  private keepAlive: boolean;

  constructor(
    private directory: string,
    private apiKey: string,
    {
      baseUrl = "https://api.browserbase.com",
      allowedDomains,
      timeoutSeconds,
      keepAlive = false,
    }: {
      baseUrl?: string;
      /** Browserbase blocks top-level navigation elsewhere; subresources still load. */
      allowedDomains?: string[];
      timeoutSeconds?: number;
      keepAlive?: boolean;
    } = {},
  ) {
    this.baseUrl = baseUrl;
    this.allowedDomains = allowedDomains;
    this.timeoutSeconds = timeoutSeconds;
    this.keepAlive = keepAlive;
  }

  private async request(resource: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${resource}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-BB-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`BROWSERBASE_HTTP_${response.status}`);
    return response.json();
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
            await this.request(
              "/v1/sessions",
              sessionRequest(
                this.directory,
                this.allowedDomains,
                this.timeoutSeconds,
                this.keepAlive,
              ),
            ),
          );
          this.sessions.set(session.id, session.projectId);
          await writeJson(path.join(this.directory, `${session.id}.json`), {
            id: session.id,
            projectId: session.projectId,
          });
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ webSocketDebuggerUrl: session.connectUrl }));
        } catch (err) {
          // Provider/transport errors can contain credentials; persist a safe failure marker.
          this.errors.push(
            `BROWSERBASE_ALLOCATION_FAILED_OR_UNKNOWN:${browserCostError(err)}`,
          );
          process.stderr.write(
            "Browserbase allocation failed; browser cost may be incomplete.\n",
          );
          response.writeHead(502).end("Browserbase allocation failed");
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
      throw new Error("BROWSERBASE_BROKER_ADDRESS_MISSING");
    return `http://127.0.0.1:${address.port}${this.route.replace(/json\/version\/$/, "")}`;
  }

  async stop() {
    this.closing = true;
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
    await Promise.all(this.pending);
    await Promise.all(
      [...this.sessions].map(async ([id, projectId]) => {
        try {
          await this.request(`/v1/sessions/${id}`, {
            projectId,
            status: "REQUEST_RELEASE",
          });
        } catch (err) {
          // Preserve successful usage collection even when release races provider teardown.
          this.errors.push(
            `BROWSERBASE_RELEASE_FAILED:${id}:${browserCostError(err)}`,
          );
        }
      }),
    );
  }

  async cost() {
    const sessions: BrowserSessionCost[] = [];
    await Promise.all(
      [...this.sessions.keys()].map(async (id) => {
        try {
          for (let attempt = 0; ; attempt++) {
            const usage = await this.request(`/v1/sessions/${id}`);
            try {
              const cost = browserbaseSessionCost(usage);
              if (cost.id !== id)
                throw new Error("BROWSERBASE_USAGE_SESSION_MISMATCH");
              sessions.push(cost);
              await writeJson(path.join(this.directory, `${id}.json`), cost);
              break;
            } catch (err) {
              if (
                err instanceof Error &&
                err.message === "BROWSERBASE_SESSION_NOT_ENDED" &&
                attempt < 4
              ) {
                // Session finalization can lag a successful release acknowledgement.
                await delay(500);
              } else {
                // Invalid usage and exhausted retries remain explicitly incomplete.
                throw err;
              }
            }
          }
        } catch (err) {
          this.errors.push(
            `BROWSERBASE_USAGE_UNAVAILABLE:${id}:${browserCostError(err)}`,
          );
        }
      }),
    );
    const result = browserCost("browserbase", sessions, this.errors);
    if (result.errors.length)
      process.stderr.write(
        `Browser cost incomplete: ${result.errors.join(", ")}\n`,
      );
    return result;
  }
}
