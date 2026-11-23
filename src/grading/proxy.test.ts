import { Codex } from "@openai/codex-sdk";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { z } from "zod";

import { selectComparisonFixtures } from "../evals/fixture-selection";
import { judge } from "./grade-fixture";
import { createGradingProxy } from "./proxy";

test("QA bench grades through the authenticated proxy and does not fall back after a 401", async () => {
  const previousUrl = process.env.GRADING_BASE_URL;
  const previousKey = process.env.GRADING_API_KEY;
  const previousFallback = process.env.GRADING_FALLBACK_BASE_URL;
  const previousHeaders = process.env.GRADING_HEADERS;
  const requests: {
    path: string | undefined;
    authorization: string | undefined;
    tag: string | undefined;
    body: { reasoning: { effort: string }; store: boolean };
  }[] = [];
  let fallbackFailure = false;
  let primaryFailure: number | "stream" | undefined;
  const output = {
    findings: [
      {
        set: "unverified",
        index: null,
        reproStepsIndex: null,
        reason: "No reference matches.",
        clarity: 5,
        severity: 3,
        severityReason: "Functional misbehavior.",
      },
    ],
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      tag:
        typeof request.headers["x-test-tag"] === "string"
          ? request.headers["x-test-tag"]
          : undefined,
      body: z
        .object({
          reasoning: z.object({ effort: z.string() }),
          store: z.boolean(),
        })
        .parse(JSON.parse(body)),
    });
    if (fallbackFailure && request.url === "/azure/v1/responses") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Azure unavailable" } }));
      return;
    }
    if (primaryFailure && request.url === "/custom/v1/responses") {
      if (primaryFailure === "stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            type: "error",
            sequence_number: 0,
            code: "server_is_overloaded",
            message:
              "Our servers are currently overloaded. Please try again later.",
            param: null,
          })}\n\n`,
        );
      } else {
        response.writeHead(primaryFailure, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: {
              message: primaryFailure === 401 ? "Unauthorized" : "Unavailable",
            },
          }),
        );
      }
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      type: "message",
      id: "message-test",
      role: "assistant",
      content: [],
    };
    for (const event of [
      {
        type: "response.created",
        response: { id: "response-test", created_at: 1, model: "gpt-6.1-sol" },
      },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        delta: JSON.stringify(output),
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: {} },
    ])
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    process.env.GRADING_BASE_URL = `http://127.0.0.1:${address.port}/custom/v1`;
    process.env.GRADING_FALLBACK_BASE_URL = `http://127.0.0.1:${address.port}/azure/v1`;
    process.env.GRADING_HEADERS = JSON.stringify({ "x-test-tag": "grader" });
    process.env.GRADING_API_KEY = "first-key";
    const first = createGradingProxy();
    process.env.GRADING_API_KEY = "second-key";
    const second = createGradingProxy();
    assert(first && second);
    const codex = new Codex({ codexPathOverride: process.execPath });
    const finding = {
      name: "Save does not persist",
      summary: "Saving discards edits.",
      expected: "Save persists edits.",
      actual: "Edits disappear.",
      reproSteps: ["Edit and save."],
    };
    const [fixture] = await selectComparisonFixtures("gitea/areas/labels");
    const assessments = await Promise.all(
      [first, second].map((runPrompt) =>
        judge(fixture, [], [], [finding], codex, undefined, runPrompt),
      ),
    );
    assert(
      assessments.every((assessment) => assessment.unverified.length === 1),
    );
    assert.deepEqual(requests.map((request) => request.authorization).sort(), [
      "Bearer first-key",
      "Bearer second-key",
    ]);
    for (const request of requests) {
      assert.equal(request.path, "/custom/v1/responses");
      assert.equal(request.tag, "grader");
      assert.equal(request.body.reasoning.effort, "high");
      assert.equal(request.body.store, false);
    }
    for (const failure of [429, 503, "stream"] as const) {
      primaryFailure = failure;
      const start = requests.length;
      assert.deepEqual(JSON.parse(await first("Grade the finding.")), output);
      assert.deepEqual(
        requests.slice(start).map((request) => request.path),
        ["/custom/v1/responses", "/azure/v1/responses"],
      );
      assert(
        requests
          .slice(start)
          .every(
            (request) =>
              request.authorization === "Bearer first-key" &&
              request.tag === "grader",
          ),
      );
    }
    fallbackFailure = true;
    const beforeFallbackFailure = requests.length;
    await assert.rejects(first("Grade the finding."), /Azure unavailable/);
    assert.equal(requests.length, beforeFallbackFailure + 2);
    primaryFailure = 401;
    const beforeUnauthorized = requests.length;
    await assert.rejects(
      judge(fixture, [], [], [finding], codex, undefined, first),
      /Unauthorized/,
    );
    assert.equal(requests.length, beforeUnauthorized + 1);
  } finally {
    if (previousFallback === undefined)
      delete process.env.GRADING_FALLBACK_BASE_URL;
    else process.env.GRADING_FALLBACK_BASE_URL = previousFallback;
    if (previousUrl === undefined) delete process.env.GRADING_BASE_URL;
    else process.env.GRADING_BASE_URL = previousUrl;
    if (previousHeaders === undefined) delete process.env.GRADING_HEADERS;
    else process.env.GRADING_HEADERS = previousHeaders;
    if (previousKey === undefined) delete process.env.GRADING_API_KEY;
    else process.env.GRADING_API_KEY = previousKey;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
