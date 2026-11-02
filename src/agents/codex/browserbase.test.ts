import assert from "node:assert/strict";
import { it } from "node:test";

import { sessionRequest } from "./browserbase";

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
