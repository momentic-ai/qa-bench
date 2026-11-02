import assert from "node:assert/strict";
import { it } from "node:test";

import { parseFullAppOptions } from "./options";

it("records --prevent-cheating only when set for Codex and Claude runs", () => {
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
    ["--agent", "codex-playwright-mcp", "--prevent-cheating", "--grade-only"],
  ])
    assert.throws(() => parseFullAppOptions(args), /--prevent-cheating/);
  for (const agent of ["claude-playwright-mcp", "claude-agent-browser"])
    assert.equal(
      parseFullAppOptions(["--agent", agent, "--prevent-cheating"])
        .preventCheating,
      true,
    );
});
