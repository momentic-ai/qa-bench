import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { openaiPrices as prices } from "../model-pricing";

export const CodexCostSchema = z
  .object({
    estimatedUsd: z.number().nonnegative().nullable(),
    costComplete: z.boolean().optional(),
  })
  .passthrough();

export type CodexCost = {
  estimatedUsd: number;
  byModel: Record<string, ModelUsage>;
  pricingSource: string;
};
type ModelUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  costUsd: number;
};
const UsageSchema = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cached_input_tokens: z.number().nullish(),
    cache_write_input_tokens: z.number().nullish(),
  })
  .passthrough();
const EventSchema = z
  .object({ type: z.string(), payload: z.unknown() })
  .passthrough();
const TurnContextSchema = z
  .object({ model: z.string().nullish() })
  .passthrough();
const TokenEventSchema = z
  .object({
    type: z.string(),
    info: z.object({ last_token_usage: UsageSchema.nullish() }).nullish(),
  })
  .passthrough();

export async function getCodexCost(codexHome: string): Promise<CodexCost> {
  const sessions = path.join(codexHome, "sessions");
  const files = await readdir(sessions, {
    recursive: true,
    withFileTypes: true,
  });
  const byModel: Record<string, ModelUsage> = {};

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) {
      continue;
    }

    const contents = await readFile(
      path.join(file.parentPath, file.name),
      "utf8",
    );
    let model: string | undefined;

    for (const line of contents.split("\n")) {
      if (!line) {
        continue;
      }

      const event = EventSchema.parse(JSON.parse(line));
      if (event.type === "turn_context") {
        // Turn context records which model subsequent usage belongs to.
        model = TurnContextSchema.parse(event.payload).model ?? undefined;
        continue;
      }
      if (event.type !== "event_msg") {
        continue;
      }
      const payload = TokenEventSchema.parse(event.payload);
      if (payload.type !== "token_count") {
        continue;
      }

      const usage = payload.info?.last_token_usage;
      if (!usage) {
        continue;
      }
      if (!model) {
        throw new Error(`Missing Codex model in ${file.name}`);
      }

      const modelPrices = prices[model];
      if (!modelPrices) {
        throw new Error(`No price for Codex model ${model}`);
      }
      const cachedInputTokens = usage.cached_input_tokens ?? 0;
      const cacheWriteInputTokens = usage.cache_write_input_tokens ?? 0;
      const uncachedInputTokens =
        usage.input_tokens - cachedInputTokens - cacheWriteInputTokens;
      if (uncachedInputTokens < 0) {
        throw new Error(`Invalid Codex token usage in ${file.name}`);
      }
      let rate = modelPrices.short;
      if (usage.input_tokens > 272_000) {
        rate = modelPrices.long;
      }
      const costUsd =
        (uncachedInputTokens * rate.input +
          cachedInputTokens * rate.cachedInput +
          cacheWriteInputTokens * rate.cacheWrite +
          usage.output_tokens * rate.output) /
        1_000_000;

      byModel[model] ||= {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      byModel[model].inputTokens += usage.input_tokens;
      byModel[model].cachedInputTokens += cachedInputTokens;
      byModel[model].cacheWriteInputTokens += cacheWriteInputTokens;
      byModel[model].outputTokens += usage.output_tokens;
      byModel[model].costUsd += costUsd;
    }
  }

  if (Object.keys(byModel).length === 0) {
    throw new Error(`No Codex usage found in ${sessions}`);
  }

  return {
    estimatedUsd: Object.values(byModel).reduce(
      (sum, model) => sum + model.costUsd,
      0,
    ),
    byModel,
    pricingSource: "https://developers.openai.com/api/docs/pricing",
  };
}
