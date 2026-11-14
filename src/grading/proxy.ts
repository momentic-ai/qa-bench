import { createOpenAI } from "@ai-sdk/openai";
import { Output, streamText } from "ai";
import { z } from "zod";

import { GRADING_THREAD_OPTIONS, JudgeOutputSchema } from "./grading-contract";

export type GradingPromptRunner = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

/** Capture one invocation's proxy credentials; failed proxy calls never fall back to OpenAI. */
export function createGradingProxy(): GradingPromptRunner | undefined {
  const server = process.env.GRADING_BASE_URL;
  if (!server) return undefined;
  const apiKey = process.env.GRADING_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error(
      "GRADING_API_KEY or OPENAI_API_KEY is required for proxied grading.",
    );
  const provider = createOpenAI({
    baseURL: server,
    apiKey,
    headers: process.env.GRADING_HEADERS
      ? z
          .record(z.string(), z.string())
          .parse(JSON.parse(process.env.GRADING_HEADERS))
      : undefined,
  });
  return async (prompt, signal) => {
    const result = streamText({
      model: provider.responses(GRADING_THREAD_OPTIONS.model),
      prompt,
      output: Output.object({ schema: JudgeOutputSchema }),
      providerOptions: {
        openai: {
          reasoningEffort: GRADING_THREAD_OPTIONS.modelReasoningEffort,
          store: false,
        },
      },
      abortSignal: signal,
      maxRetries: 0,
      // Await output to surface errors without logging the full grading payload.
      onError: () => undefined,
    });
    await result.consumeStream();
    return JSON.stringify(await result.output);
  };
}
