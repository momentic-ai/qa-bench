# QA bench

A benchmark of AI QA agents finding real bugs in open-source web apps. It runs
Mo, Codex, Claude Code and Devin against product areas of Metabase, Saleor
(vouchers), Gitea and Twenty, then grades their bug reports against
human-reviewed labels.

Momentic builds Mo and maintains this benchmark.

Each run gets a fresh copy of the app at a pinned commit, with seeded data, in
its own E2B sandbox. Areas live in [`fixtures/oss`](fixtures/oss).

## Results

Results will be published in [`results/results.csv`](results/results.csv).

## Run it

You need Node.js 22.12+, pnpm, and an [E2B](https://e2b.dev) account. Build the
sandbox templates once per E2B org. Twenty needs the larger one.

```bash
pnpm install
pnpm build-template
pnpm build-template --cpu 4 --memory 8
```

| Environment variable                   | Needed for                                            |
| -------------------------------------- | ----------------------------------------------------- |
| `E2B_API_KEY`                          | All runs                                              |
| `OPENAI_API_KEY`                       | All runs (grading), Codex                             |
| `ANTHROPIC_API_KEY`                    | Claude Code                                           |
| `BROWSERBASE_API_KEY`                  | Codex and Claude Code, unless using `--browser local` |
| `MOMENTIC_API_KEY`                     | Mo, unless signed in with `qa login`                  |
| `DEVIN_ORGANIZATION_ID`, `DEVIN_TOKEN` | Devin ([setup](src/agents/devin/README.md))           |

Mo runs on Momentic's hosted service, so it needs a Momentic account and the
[`qa` CLI](https://www.npmjs.com/package/qa). Runs require version 0.27.0:

```bash
npm install -g qa@0.27.0
```

Run one agent on one area, then compare saved runs:

```bash
pnpm eval --agent codex-playwright-mcp --fixtures saleor/areas/vouchers --minutes 30
pnpm merge --fixtures saleor/areas/vouchers
```

`--agent` takes `mo`, `codex-playwright-mcp`, `claude-playwright-mcp`,
`codex-agent-browser`, `claude-agent-browser` or `devin-qa`. `--fixtures` takes
an app (`gitea`), all of its areas (`gitea/areas`), one area, or `oss-areas`.

Each run is graded when it finishes and saved to
`reports/<agent>/<fixture>/<run-id>/`. `merge` writes `reports/comparison.md`.

## Methodology

**Brief.** Every agent gets the same short brief from
[`bugbash-brief.ts`](src/evals/bugbash-brief.ts): the app URL, test accounts, the
area's scope and entry points, and the rules to report only verified bugs and not
read benchmark files. Codex, Claude Code and Devin are also told which browser to
use and how to save findings. Devin's prompt adds its
[isolation rules](src/agents/devin/README.md).

**Time.** `--minutes` sets a limit from 1 to 120, stated in the brief. Without
it, the brief states no limit and the run stops at 2 hours. A minute before the
stop, each agent is told to save its work. Durations exclude fixture setup and
grading.

**Mo's budget.** `--effort low|medium|high|max` sets Mo's budget. It applies only
to Mo.

**Agents.** Versions are pinned in [`package.json`](package.json).

| Agent       | Model and reasoning effort   | Browser                         |
| ----------- | ---------------------------- | ------------------------------- |
| Mo          | Chosen by Momentic's service | Hosted by Momentic              |
| Codex       | `gpt-6.1-sol`, medium        | Playwright MCP or agent-browser |
| Claude Code | `claude-opus-5-5`, medium    | Playwright MCP or agent-browser |
| Devin       | Devin's defaults             | Devin's native browser          |

**Browsers and subagents.**

- `*-playwright-mcp` agents use Playwright MCP on Browserbase. The parent and
  each subagent get their own Browserbase browser.
- `*-agent-browser` agents use the pinned
  [agent-browser](https://www.npmjs.com/package/agent-browser) CLI and its
  bundled skill. Each run connects to one Browserbase browser, and the agent
  decides how to share it.
- `--browser local` swaps Browserbase for headless Chromium on the host.
  Playwright MCP runs then have no subagents, and `merge` labels them separately.
- Mo manages its own subagents, and `--max-concurrent-sub-agents` caps them.
  Devin runs in one session with no child sessions.

## Scoring

A judge model (`gpt-6.1-sol`, high reasoning) reads each area's
[labels](#labels) and sorts every finding. It first groups reports of the same
failure, then classifies the best report in each group:

| Result    | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| Correct   | Matches a label in `ground-truth.json`. Each label matches one finding |
| Incorrect | Matches a rejected claim in `known-invalid.json`                       |
| Unmatched | Matches neither. It may be a new bug, and is neither right nor wrong   |
| Dup.      | An extra report of a failure already in a group                        |

Findings that match another area's labels are recorded separately and left out
of every metric below. The judge is a model, so regrading can change a few
matches. Its full prompt is in
[`grading-contract.ts`](src/evals/grading-contract.ts).

| Metric           | Definition                                      |
| ---------------- | ----------------------------------------------- |
| Findings         | Correct + Incorrect + Unmatched + Dup.          |
| Precision        | Correct / (Correct + Incorrect)                 |
| Recall           | Correct / labeled bugs in the area              |
| Score            | Severity of Correct findings − Incorrect − Dup. |
| Cost per run     | Mean cost of a run                              |
| Cost per correct | Cost / Correct                                  |

Severity comes from the label: 1 for cosmetic issues, 3 for functional bugs and 5
for broken pages or raw error dumps. Unmatched findings don't affect Precision or
Score.

In the results CSV, each row is the mean over an agent's runs of one area.
Precision, Recall and cost per correct are calculated from those means. Totals
sum the rows and recalculate the ratios from the sums.

Costs are directional:

- Codex is token usage at list prices, plus estimated Browserbase time.
- Claude Code is the cost reported by the Agent SDK, plus estimated Browserbase
  time.
- Mo is its reported session spend.
- Devin has no USD cost.

None include E2B or grading.

`scores.csv` uses `known_hits`, `known_invalid`, `unverified` and `duplicates`
for Correct, Incorrect, Unmatched and Dup. Its `precision` field also counts
duplicates of classified findings, so it can differ from the definition above.

## Labels

Each area in `fixtures/oss/<app>/e2e/areas/<area>/` has:

- `fixture.json`: scope and entry points
- `ground-truth.json`: confirmed bugs
- `known-invalid.json`: rejected claims

To add labels:

1. Open `review.md` in a run's report folder. It lists every finding and its
   result.
2. Reproduce the finding. `pnpm start-fixture <fixture> --timeout 30m` starts an
   app, and `pnpm stop-fixture <sandbox-id>` stops it.
3. Add a confirmed bug to `ground-truth.json` with `name`, `summary`, `expected`,
   `actual`, `reproSteps` and `severity`. Add a rejected claim to
   `known-invalid.json` with those fields, minus `severity`, plus `reason`.
4. Regrade every agent, since `merge` won't compare scores from different labels:

```bash
pnpm eval --agent mo --fixtures saleor/areas/vouchers --grade-only
```

## Contributing

Run `pnpm lint`, `pnpm format:check` and `pnpm typecheck` before opening a PR.
