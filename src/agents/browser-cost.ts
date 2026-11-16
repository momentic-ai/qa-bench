import { z } from "zod";

// Published usage rates, checked 2026-10-12. Excludes subscriptions and included credits.
// Browserbase uses Developer overage rates.
export const BROWSERBASE_PRICING = {
  usdPerHour: 0.12,
  usdPerProxyGb: 12,
  source: "https://docs.browserbase.com/account/billing/plans",
  billingUnitSeconds: 60,
  proxyBillingUnitBytes: 1_000_000,
};
export type BrowserCost = {
  provider: "browserbase";
  estimatedUsd: number | null;
  complete: boolean;
  pricing: typeof BROWSERBASE_PRICING;
  sessions: BrowserSessionCost[];
  errors: string[];
};
export type BrowserSessionCost = {
  id: string;
  seconds: number;
  proxyBytes?: number;
  billedSeconds?: number;
  billedProxyBytes?: number;
  estimatedUsd: number;
  complete: boolean;
};
export const BrowserbaseUsageSchema = z.object({
  id: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullish(),
  proxyBytes: z.number().nonnegative(),
});
export function browserbaseSessionCost(input: unknown): BrowserSessionCost {
  const session = BrowserbaseUsageSchema.parse(input);
  if (!session.endedAt) {
    // A still-running browser has no final duration; do not substitute the agent deadline.
    throw new Error("BROWSERBASE_SESSION_NOT_ENDED");
  }
  const seconds =
    (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000;
  if (seconds < 0) throw new Error("BROWSERBASE_INVALID_DURATION");
  // Apply the published per-session minute/MB minimums and round up to billing units.
  const billedSeconds = Math.max(60, Math.ceil(seconds / 60) * 60);
  const billedProxyBytes =
    session.proxyBytes === 0 ? 0 : Math.ceil(session.proxyBytes / 1e6) * 1e6;
  return {
    id: session.id,
    seconds,
    proxyBytes: session.proxyBytes,
    billedSeconds,
    billedProxyBytes,
    estimatedUsd:
      (billedSeconds / 3600) * BROWSERBASE_PRICING.usdPerHour +
      (billedProxyBytes / 1e9) * BROWSERBASE_PRICING.usdPerProxyGb,
    complete: true,
  };
}
export function browserCost(
  provider: BrowserCost["provider"],
  sessions: BrowserSessionCost[],
  errors: string[],
): BrowserCost {
  const unique = [
    ...new Map(sessions.map((session) => [session.id, session])).values(),
  ];
  return {
    provider,
    estimatedUsd:
      unique.length || errors.length === 0
        ? unique.reduce((sum, session) => sum + session.estimatedUsd, 0)
        : null,
    complete:
      errors.length === 0 && unique.every((session) => session.complete),
    pricing: BROWSERBASE_PRICING,
    sessions: unique,
    errors,
  };
}
export function combinedCost(
  modelCostUsd: number | null,
  modelComplete: boolean,
  browser: BrowserCost,
) {
  return {
    modelCostUsd,
    browserCostUsd: browser.estimatedUsd,
    estimatedUsd:
      modelCostUsd === null && browser.estimatedUsd === null
        ? null
        : (modelCostUsd ?? 0) + (browser.estimatedUsd ?? 0),
    costComplete: modelCostUsd !== null && modelComplete && browser.complete,
    includesBrowserCosts: browser.estimatedUsd !== null,
    browser,
  };
}

export function browserCostError(err: unknown) {
  if (err instanceof z.ZodError) {
    // Retain schema failure locations without logging provider values or connection URLs.
    return `INVALID_USAGE:${err.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",")}`;
  }
  if (err instanceof Error && /^BROWSERBASE_[A-Z0-9_]+$/.test(err.message)) {
    // Our provider errors contain HTTP status or lifecycle state, never response bodies.
    return err.message;
  }
  const transport = z
    .object({ cause: z.object({ code: z.string() }) })
    .safeParse(err);
  return transport.success && /^[A-Z0-9_]+$/.test(transport.data.cause.code)
    ? `TRANSPORT:${transport.data.cause.code}`
    : "TRANSPORT_OR_LOCAL_IO_FAILURE";
}
