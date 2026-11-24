import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { TestingBrowser } from "../testing-browser";

const require = createRequire(import.meta.url);
export const DISABLED_BROWSER_TOOL = "browser_run_code_unsafe";
// Sites holding upstream issues, fixes or this benchmark's labels, copies of them,
// and search engines that lead to them. Playwright matches a bare host exactly, so
// each domain also gets a `*.` pattern; `*` spans dots, so `google.*` covers google.co.uk.
const ANSWER_DOMAINS = [
  // Code hosts, plus GitHub viewers, mirrors and raw-file proxies
  "github.com",
  "githubusercontent.com",
  "github.dev",
  "github1s.com",
  "githubbox.com",
  "githack.com",
  "statically.io",
  "gitlab.com",
  "codeberg.org",
  "gitea.com",
  "bitbucket.org",
  "gitee.com",
  // Code search and AI repository readers
  "sourcegraph.com",
  "grep.app",
  "deepwiki.com",
  "gitingest.com",
  "uithub.com",
  // The published dataset, its mirrors and dataset hubs, and Mo sessions linked from labels
  "huggingface.co",
  "hf.co",
  "hf-mirror.com",
  "modelscope.cn",
  "modelscope.ai",
  "wisemodel.cn",
  "gitcode.com",
  "opendatalab.com",
  "kaggle.com",
  "paperswithcode.com",
  "app.momentic.ai",
  // Upstream forums
  "discourse.metabase.com",
  "forum.gitea.com",
  // Archives and translation proxies that serve copies of blocked pages
  "archive.org",
  "archive.ph",
  "archive.today",
  "archive.is",
  "archive.li",
  "archive.md",
  "translate.goog",
  // Search and AI answer engines
  "google.*",
  "bing.com",
  "duckduckgo.com",
  "duck.com",
  "duck.ai",
  "search.yahoo.*",
  "yandex.*",
  "ya.ru",
  "baidu.com",
  "naver.com",
  "seznam.cz",
  "so.com",
  "sogou.com",
  "search.aol.com",
  "ask.com",
  "swisscows.com",
  "metager.org",
  "presearch.com",
  "yep.com",
  "ecosia.org",
  "startpage.com",
  "qwant.com",
  "search.brave.com",
  "kagi.com",
  "mojeek.com",
  "you.com",
  "perplexity.ai",
  "phind.com",
  "chatgpt.com",
  "chat.openai.com",
  "copilot.microsoft.com",
  "claude.ai",
];
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
