import assert from "node:assert/strict";
import { it } from "node:test";

import { parseFullAppOptions } from "./options";

it("records --prevent-cheating only when set, and only for Codex runs", () => {
  assert.equal(
    parseFullAppOptions(["--agent", "codex-playwright-mcp"]).preventCheating,
    undefined,
  );
  assert.equal(
    parseFullAppOptions([
      "--agent",
      "codex-playwright-mcp",
      "--prevent-cheating",
    ]).preventCheating,
    true,
  );
  assert.equal(
    parseFullAppOptions([
      "--agent",
      "codex-agent-browser",
      "--prevent-cheating",
    ]).preventCheating,
    true,
  );
  for (const args of [
    ["--prevent-cheating"],
    ["--agent", "mo", "--prevent-cheating"],
    ["--agent", "claude-playwright-mcp", "--prevent-cheating"],
    ["--agent", "codex-playwright-mcp", "--prevent-cheating", "--grade-only"],
  ])
    assert.throws(() => parseFullAppOptions(args), /--prevent-cheating/);
});
