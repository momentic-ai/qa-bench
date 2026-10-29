import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { z } from "zod";

import { bugbashBrief } from "../../evals/bugbash-brief";
import { Fixture } from "../../evals/types";
import { DevinQaAgent } from "./qa-agent";
import { DevinApiError, DevinQaClient } from "./qa-client";
import { profileRequest } from "./qa-security";

it("handles nullable launch metadata, retryable cleanup failures and asynchronous shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devin-lifecycle-"));
  const url = new URL("https://3000-test.e2b.app");
  const report = {
    bugs: [],
    areasExplored: ["Companies list"],
    limitations: [],
  };
  const profile = { ...profileRequest([url.hostname]), profile_id: "profile" };
  const session = {
    session_id: "session",
    url: "https://app.devin.ai/sessions/session",
    status: "running",
    status_detail: null,
    security_profile: null,
    structured_output: null,
  };
  class Client extends DevinQaClient {
    prompt = "";
    reads = 0;
    stopReads = 0;
    deletes = 0;
    failures = 3;

    constructor() {
      super("organization", "test-token");
    }

    override async request(
      endpoint: string,
      options: Parameters<DevinQaClient["request"]>[1] = {},
    ): Promise<unknown> {
      if (endpoint === "default-platform")
        return { platform: null, outpost_pool_id: null };
      if (endpoint.startsWith("security-profiles?"))
        return { items: [profile], has_next_page: false, end_cursor: null };
      if (
        endpoint.startsWith("repositories?") ||
        endpoint.startsWith("knowledge/notes?")
      )
        return { items: [], has_next_page: false, end_cursor: null };
      if (endpoint === "sessions") {
        const body = z
          .object({
            prompt: z.string(),
            security_profile: z.object({ profile_id: z.literal("profile") }),
          })
          .parse(options.body);
        this.prompt = body.prompt;
        return session;
      }
      assert.equal(endpoint, "sessions/session");
      if (options.method === "DELETE") {
        this.deletes++;
        if (this.failures-- > 0) throw new DevinApiError(503, endpoint);
        return session;
      }
      if (this.deletes)
        return {
          ...session,
          status: ++this.stopReads > 1 ? "exit" : "running",
          structured_output: report,
        };
      if (++this.reads === 1) return session;
      return {
        ...session,
        security_profile: { profile_id: "profile" },
        status_detail: "waiting_for_user",
        structured_output: report,
      };
    }
  }
  const fixture: Fixture = {
    type: "full-app",
    name: "test",
    directory,
    port: 3000,
    username: "test",
    password: "test",
    groundTruthFile: "unused",
    deployment: { compose: [], composeFiles: [] },
  };
  const client = new Client();
  const agent = new DevinQaAgent(
    {
      fixture,
      targetUrl: url,
      timeLimitMs: 1_800_000,
      reportDirectory: directory,
      runDirectory: directory,
    },
    client,
  );
  try {
    const signal = AbortSignal.timeout(15_000);
    const execution = await agent.start(
      bugbashBrief(url, 1_800_000, fixture, "Devin native browser"),
      signal,
      undefined,
      () => Date.now() + 1_800_000,
    );
    await execution.completion;
    await assert.rejects(
      agent.terminate(),
      (error) => error instanceof DevinApiError && error.status === 503,
    );
    assert.equal(client.deletes, 3);
    await agent.terminate();
    assert.deepEqual(await agent.collectResults(signal), {
      bugCount: 0,
      costUsd: null,
      sessionId: "session",
    });
    assert.equal(client.deletes, 4);
    assert.equal(client.stopReads, 2);
    assert.match(client.prompt, /Use Devin native browser/);
    assert.doesNotMatch(client.prompt, /Playwright MCP/);
    const intent = z
      .object({ prompt: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            path.join(directory, "devin-launch-intent.json"),
            "utf8",
          ),
        ),
      );
    assert.equal(intent.prompt, client.prompt);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
      report,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
