import { z } from "zod";

export class DevinApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Devin API ${endpoint}: HTTP ${status}`);
  }
}

/** Credentials belong to one eval invocation and never enter its artifacts. */
export class DevinQaClient {
  constructor(
    private readonly organizationId: string,
    private readonly token: string,
  ) {}

  static fromEnvironment() {
    const organizationId = process.env.DEVIN_ORGANIZATION_ID;
    const token = process.env.DEVIN_TOKEN;
    if (!organizationId || !token)
      throw new Error("DEVIN_ORGANIZATION_ID and DEVIN_TOKEN are required.");
    return new DevinQaClient(organizationId, token);
  }

  async request(
    endpoint: string,
    {
      method = "GET",
      body,
      signal,
      beta = false,
    }: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      signal?: AbortSignal;
      beta?: boolean;
    } = {},
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.devin.ai/${beta ? "v3beta1" : "v3"}/organizations/${encodeURIComponent(this.organizationId)}/${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      },
    );
    // Provider error payloads can echo task credentials; keep them out of logs.
    if (!response.ok) throw new DevinApiError(response.status, endpoint);
    if (response.status === 204) return null;
    return response.json();
  }

  async list(endpoint: string, signal?: AbortSignal, beta = false) {
    const items: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ first: "100" });
      if (cursor) query.set("after", cursor);
      const page = z
        .object({
          items: z.array(z.unknown()),
          has_next_page: z.boolean(),
          end_cursor: z.string().nullable(),
        })
        .parse(await this.request(`${endpoint}?${query}`, { signal, beta }));
      items.push(...page.items);
      if (!page.has_next_page) break;
      if (!page.end_cursor || page.end_cursor === cursor)
        throw new Error(`Devin returned an invalid cursor for ${endpoint}.`);
      cursor = page.end_cursor;
    } while (cursor);
    return items;
  }
}
