export class BrowserUseApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Browser Use API ${endpoint}: HTTP ${status}`);
  }
}

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
      version = "v4",
    }: {
      method?: "GET" | "POST" | "PATCH";
      body?: unknown;
      signal?: AbortSignal;
      /** Browser sessions without an agent live in v3. */
      version?: "v3" | "v4";
    } = {},
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.browser-use.com/api/${version}/${endpoint}`,
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
    return response.json();
  }

  isTransient(error: unknown) {
    return (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof BrowserUseApiError &&
        (error.status === 429 || error.status >= 500))
    );
  }
}
