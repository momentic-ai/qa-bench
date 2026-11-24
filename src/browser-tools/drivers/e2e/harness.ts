// Copied next to e2e.config.ts in the agent's workspace, which imports it.
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { appendFileSync } from "node:fs";
import { z } from "zod";

export type E2EModel = { provider: "openai" | "anthropic"; id: string };

export const E2E_SETUP_VARIABLE = "QA_BENCH_E2E";

const E2ESetupSchema = z.object({
  targetUrl: z.string(),
  /** A Browserbase broker URL; without it e2e launches local Chromium. */
  broker: z.string().optional(),
  model: z.object({
    provider: z.enum(["openai", "anthropic"]),
    id: z.string(),
  }),
  journal: z.string(),
  credentials: z.record(
    z.string(),
    z.object({ username: z.string(), password: z.string() }),
  ),
});

export type E2ESetup = z.infer<typeof E2ESetupSchema>;

export function readE2ESetup() {
  const setup = process.env[E2E_SETUP_VARIABLE];
  if (!setup) throw new Error(`${E2E_SETUP_VARIABLE} is not set.`);
  return E2ESetupSchema.parse(JSON.parse(setup));
}

/** Appends each call's token usage to `journal`, so the run's cost includes e2e's model. */
export function meteredModel({ provider, id }: E2EModel, journal: string) {
  return wrapLanguageModel({
    model: provider === "openai" ? openai(id) : anthropic(id),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        appendFileSync(
          journal,
          `${JSON.stringify({ provider, model: id, usage: result.usage })}\n`,
        );
        return result;
      },
    },
  });
}
