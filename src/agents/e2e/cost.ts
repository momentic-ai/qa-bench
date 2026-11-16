import { readFile } from "node:fs/promises";
import { z } from "zod";

import { anthropicPrices, openaiPrices as prices } from "../model-pricing";

const E2ECallSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string(),
  usage: z.object({
    inputTokens: z.object({
      total: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    }),
    outputTokens: z.object({ total: z.number().optional() }),
  }),
});

/** Prices the explorer model calls that e2e's metered model appends to `journal`. */
export async function getE2EModelCost(journal: string) {
  let estimatedUsd = 0;
  let calls = 0;
  for (const line of (await readFile(journal, "utf8")).split("\n")) {
    if (!line) continue;
    const { provider, model, usage } = E2ECallSchema.parse(JSON.parse(line));
    const input = usage.inputTokens.total ?? 0;
    const cacheRead = usage.inputTokens.cacheRead ?? 0;
    const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
    const rate =
      provider === "anthropic"
        ? anthropicPrices[model]
        : input > 272_000
          ? prices[model]?.long
          : prices[model]?.short;
    if (!rate) throw new Error(`No price for e2e model ${model}`);
    estimatedUsd +=
      ((input - cacheRead - cacheWrite) * rate.input +
        cacheRead * rate.cachedInput +
        cacheWrite * rate.cacheWrite +
        (usage.outputTokens.total ?? 0) * rate.output) /
      1_000_000;
    calls++;
  }
  return { estimatedUsd, calls };
}
