import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { fixtureHostnames } from "../hosted-agents";

export class BrowserUseApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Browser Use API ${endpoint}: HTTP ${status}`);
  }
}

export const CloudBrowserSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    agentSessionId: z.string().nullish(),
    cdpUrl: z.string().nullish(),
    browserCost: z.string().nullish(),
    proxyCost: z.string().nullish(),
  })
  .passthrough();
export type CloudBrowser = z.infer<typeof CloudBrowserSchema>;

/** Credentials belong to one eval invocation and never enter its artifacts. */
export class BrowserUseClient {
  constructor(private readonly apiKey: string) {}

  static fromEnvironment() {
    const apiKey = process.env.BROWSER_USE_API_KEY;
    if (!apiKey) throw new Error("BROWSER_USE_API_KEY is required.");
    return new BrowserUseClient(apiKey);
  }

  async request(
    endpoint: string,
    {
      method = "GET",
      body,
      signal,
    }: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.browser-use.com/api/v4/${endpoint}`,
      {
        method,
        headers: {
          "X-Browser-Use-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      },
    );
    // Provider error payloads can echo task credentials; keep them out of logs.
    if (!response.ok) throw new BrowserUseApiError(response.status, endpoint);
    return response.status === 204 ? undefined : response.json();
  }

  isTransient(error: unknown) {
    return (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof BrowserUseApiError &&
        (error.status === 429 || error.status >= 500))
    );
  }

  /** Blocks browser navigation to every host but the fixture's; built-in search is not covered. */
  async createFixturePolicy(targetUrl: URL, signal: AbortSignal) {
    return z.object({ id: z.string().min(1) }).parse(
      await this.request("network-policies", {
        method: "POST",
        body: {
          name: `momentic-qa-${randomUUID()}`,
          defaultAction: "block",
          allow: { domains: fixtureHostnames(targetUrl) },
        },
        signal,
      }),
    ).id;
  }

  /** Projects hold at most 100 policies, so each run deletes its own. */
  async deletePolicy(id: string) {
    await this.request(`network-policies/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getBrowser(id: string, signal?: AbortSignal) {
    return CloudBrowserSchema.parse(
      await this.request(`browsers/${encodeURIComponent(id)}`, { signal }),
    );
  }

  /** The browser an agent session runs in; the session API does not name it. */
  async findSessionBrowser(sessionId: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const { items } = z
        .object({ items: z.array(CloudBrowserSchema) })
        .parse(await this.request("browsers?pageSize=100", { signal }));
      const browser = items.find((item) => item.agentSessionId === sessionId);
      if (browser) return browser;
      await delay(2000, undefined, { signal });
    }
    return undefined;
  }

  /** Stops a browser now instead of after its idle timeout, which bills by the minute. */
  async stopBrowser(id: string) {
    const stopped = AbortSignal.timeout(120_000);
    while (true) {
      try {
        await this.request(`browsers/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { action: "stop" },
          signal: stopped,
        });
        return;
      } catch (error) {
        if (!this.isTransient(error)) throw error;
      }
      await delay(2000, undefined, { signal: stopped });
    }
  }
}

/** Browser time plus proxy traffic, as the browser reports them. */
export function browserUsd(browser: CloudBrowser) {
  return Number(browser.browserCost ?? 0) + Number(browser.proxyCost ?? 0);
}
