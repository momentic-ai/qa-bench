import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, Output, StreamProviderError, streamText } from "ai";
import { z } from "zod";

import { GRADING_THREAD_OPTIONS, JudgeOutputSchema } from "./contract";

export type GradingPromptRunner = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

/** Capture proxy credentials and retry transient failures once through the configured fallback. */
export function createGradingProxy(): GradingPromptRunner | undefined {
  const server = process.env.GRADING_BASE_URL;
  if (!server) return undefined;
  const apiKey = process.env.GRADING_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error(
      "GRADING_API_KEY or OPENAI_API_KEY is required for proxied grading.",
    );
  const headers = process.env.GRADING_HEADERS
    ? z
        .record(z.string(), z.string())
        .parse(JSON.parse(process.env.GRADING_HEADERS))
    : undefined;
  const fallbackServer = process.env.GRADING_FALLBACK_BASE_URL;
  const provider = createOpenAI({ baseURL: server, apiKey, headers });
  const fallback = fallbackServer
    ? createOpenAI({ baseURL: fallbackServer, apiKey, headers })
    : undefined;

  async function run(
    provider: ReturnType<typeof createOpenAI>,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let streamError: unknown;
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
      onError: ({ error }) => {
        streamError = error;
      },
    });
    await result.consumeStream();
    if (streamError !== undefined) throw streamError;
    return JSON.stringify(await result.output);
  }

  return async (prompt, signal) => {
    try {
      return await run(provider, prompt, signal);
    } catch (error) {
      if (
        !fallback ||
        signal?.aborted ||
        !(
          (APICallError.isInstance(error) ||
            StreamProviderError.isInstance(error)) &&
          error.isRetryable
        )
      )
        throw error;
      console.warn(
        "Grading proxy failed transiently; trying the fallback proxy.",
      );
      return run(fallback, prompt, signal);
    }
  };
}
