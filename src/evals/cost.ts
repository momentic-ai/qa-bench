import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { runMoCommand } from "./mo-cli";

export async function getMoCost(
  sessionId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const stdout = await runMoCommand(["cost", sessionId], {
    signal,
  });
  return JSON.parse(stdout);
}

type TokenPrices = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
};
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

// Standard USD prices per million tokens: https://developers.openai.com/api/docs/pricing
const prices: Record<string, { short: TokenPrices; long: TokenPrices }> = {
  "gpt-6.1-sol": {
    short: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  },
  "gpt-6.1-terra": {
    short: { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
    long: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 },
  },
  "gpt-6-sol": {
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
  },
  "gpt-6-luna": {
    short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  "gpt-5.6-luna": {
    short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  "gpt-5.6-terra": {
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  },
};

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

// Standard USD prices per million tokens: https://platform.claude.com/docs/en/about-claude/pricing
const anthropicPrices: Record<string, TokenPrices> = {
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5-5": {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 10,
  },
};
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
