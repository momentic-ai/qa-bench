// Imported by the e2e.config.ts that prepareE2E writes into the agent's workspace.
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { appendFileSync } from "node:fs";

export type E2EModel = { provider: "openai" | "anthropic"; id: string };

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
