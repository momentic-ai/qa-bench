import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { ANSWER_DOMAINS } from "../../shared/answer-domains";
import { TestingBrowser } from "../testing-browser";

const require = createRequire(import.meta.url);
export const DISABLED_BROWSER_TOOL = "browser_run_code_unsafe";
// Playwright matches a bare host exactly, so each domain also gets a `*.` pattern.
// Trailing-dot hostnames (github.com.) reach the same sites, so block those too.
const ANSWER_SOURCES = ANSWER_DOMAINS.flatMap((domain) => [
  domain,
  `*.${domain}`,
  `${domain}.`,
  `*.${domain}.`,
]);

export class PlaywrightMcp extends TestingBrowser {
  protected unsandboxedShell = false;
  protected blocksSitesLocally = true;
  private temporaryDirectory: string | undefined;

  protected async setup() {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pw-eval-"));
    this.temporaryDirectory = temporaryDirectory;
    await mkdir(this.artifacts, { recursive: true });
    const browser = await this.connect();
    return {
      playwright: {
        command: process.execPath,
        cwd: this.artifacts,
        args: [
          path.join(
            path.dirname(require.resolve("@playwright/mcp/package.json")),
            "cli.js",
          ),
          ...browser.args,
          "--output-dir",
          this.artifacts,
          ...(this.options.preventCheating
            ? ["--blocked-origins", ANSWER_SOURCES.join(";")]
            : []),
        ],
        env: { ...browser.env, TMPDIR: temporaryDirectory },
      },
      subagents: this.options.browser !== "local",
    };
  }

  async close() {
    await super.close();
    if (this.temporaryDirectory)
      await rm(this.temporaryDirectory, { recursive: true, force: true });
  }
}
