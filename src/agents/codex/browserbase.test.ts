import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { z } from "zod";

import { BrowserbaseSessions, sessionRequest } from "./browserbase";

it("limits Browserbase navigation only when allowed domains are given", () => {
  const directory = "/runs/codex-playwright-mcp/run-1/browser-sessions";
  assert.deepEqual(sessionRequest(directory), {
    userMetadata: { moEvalRun: "run-1" },
  });
  assert.deepEqual(sessionRequest(directory, ["3000-fixture.e2b.app"]), {
    userMetadata: { moEvalRun: "run-1" },
    browserSettings: { allowedDomains: ["3000-fixture.e2b.app"] },
  });
  assert.deepEqual(
    sessionRequest(directory, ["3000-fixture.e2b.app"], 3720, true),
    {
      userMetadata: { moEvalRun: "run-1" },
      timeout: 3720,
      keepAlive: true,
      browserSettings: { allowedDomains: ["3000-fixture.e2b.app"] },
    },
  );
});

it("releases a stopped owner's provider sessions without releasing another agent's browser", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qa-provider-test-"));
  const releases: string[] = [];
  let sequence = 0;
  const api = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    assert.equal(request.headers["x-bb-api-key"], "test-key");
    if (request.url === "/v1/sessions") {
      const id = String(++sequence);
      const input = z
        .object({ userMetadata: z.object({ agentId: z.string() }) })
        .parse(JSON.parse(body));
      assert.ok(["parent", "child"].includes(input.userMetadata.agentId));
      response.writeHead(200).end(
        JSON.stringify({
          id,
          projectId: "project",
          connectUrl: `wss://secret.invalid/${id}`,
        }),
      );
    } else {
      assert.equal(
        z.object({ status: z.string() }).parse(JSON.parse(body)).status,
        "REQUEST_RELEASE",
      );
      releases.push(request.url ?? "");
      response.writeHead(200).end("{}");
    }
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const sessions = new BrowserbaseSessions(directory, "test-key", {
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  try {
    const [parent, child] = await Promise.all([
      sessions.create("parent"),
      sessions.create("child"),
    ]);
    assert.notEqual(parent.id, child.id);
    await Promise.all([
      sessions.releaseAgent("child"),
      sessions.releaseAgent("child"),
    ]);
    assert.deepEqual(releases, [`/v1/sessions/${child.id}`]);
    const attribution = await readFile(
      path.join(directory, `${child.id}.json`),
      "utf8",
    );
    assert.ok(attribution.includes('"child"'));
    assert.ok(!attribution.includes("wss://"));
    await sessions.stop();
    assert.deepEqual(
      new Set(releases),
      new Set([`/v1/sessions/${parent.id}`, `/v1/sessions/${child.id}`]),
    );
    assert.equal(releases.length, 2);
    await assert.rejects(sessions.create("parent"), /closed/);
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
