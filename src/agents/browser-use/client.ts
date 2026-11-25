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
    metadata: z.record(z.string(), z.string()).nullish(),
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
    const name = `momentic-qa-${randomUUID()}`;
    try {
      return z.object({ id: z.string().min(1) }).parse(
        await this.request("network-policies", {
          method: "POST",
          body: {
            name,
            defaultAction: "block",
            allow: { domains: fixtureHostnames(targetUrl) },
          },
          signal,
        }),
      ).id;
    } catch (error) {
      // The provider may have created it even though no ID came back.
      await this.deletePolicyNamed(name).catch(() => undefined);
      throw error;
    }
  }

  private async deletePolicyNamed(name: string) {
    const { items } = z
      .object({
        items: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(await this.request("network-policies?pageSize=100"));
    const policy = items.find((item) => item.name === name);
    if (policy) await this.deletePolicy(policy.id);
  }

  /** Projects hold at most 100 policies, so runs delete the policies they create. */
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

  /** Finds a run whose create response was lost, by the workspace made for it. */
  async findWorkspaceRun(workspaceId: string) {
    const { runs } = z
      .object({
        runs: z.array(
          z.object({
            id: z.string().min(1),
            sessionId: z.string().min(1),
            workspaceId: z.string().nullish(),
          }),
        ),
      })
      .parse(await this.request("runs?limit=50"));
    return runs.find((run) => run.workspaceId === workspaceId);
  }

  /** Finds a browser whose create response was lost, by the metadata sent with it. */
  async findBrowserByMetadata(key: string, value: string) {
    const { items } = z
      .object({ items: z.array(CloudBrowserSchema) })
      .parse(await this.request("browsers?pageSize=100"));
    return items.find((item) => item.metadata?.[key] === value);
  }

  async deleteWorkspace(id: string) {
    await this.request(`workspaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
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

/** Browser time plus proxy traffic, as the browser reports them; null when either is missing or invalid. */
export function browserUsd(browser: CloudBrowser) {
  return sumUsd([browser.browserCost, browser.proxyCost]);
}

/** Sums provider USD strings; null unless every part is a finite, nonnegative number. */
export function sumUsd(parts: (string | null | undefined)[]) {
  const values = parts.map((part) => (part == null ? NaN : Number(part)));
  return values.every((value) => Number.isFinite(value) && value >= 0)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}
