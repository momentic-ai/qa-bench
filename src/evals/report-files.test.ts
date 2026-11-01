import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { runLabel } from "./report-files";

it("labels prevent-cheating runs so merge keeps them apart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-label-"));
  try {
    const file = path.join(directory, "duration.json");
    await writeFile(file, JSON.stringify({ browser: "local" }));
    assert.equal(
      await runLabel("codex-playwright-mcp", directory),
      "codex-playwright-mcp (local browser)",
    );
    await writeFile(
      file,
      JSON.stringify({ browser: "local", preventCheating: true }),
    );
    assert.equal(
      await runLabel("codex-playwright-mcp", directory),
      "codex-playwright-mcp (local browser, prevent-cheating)",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
