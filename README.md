# QA bench

A benchmark of AI QA agents finding real bugs in open-source web apps. It runs
Mo, Codex, Claude Code and Devin against product areas of Metabase, Saleor
(vouchers), Gitea and Twenty, then grades their bug reports against
human-reviewed labels.

Momentic builds Mo and maintains this benchmark.

Each run gets a fresh copy of the app at a pinned commit, with seeded data, in
its own E2B sandbox. Areas live in [`fixtures/oss`](fixtures/oss).

## Results

Per-area results are in [`results/2026-10-30.csv`](results/2026-10-30.csv). This
summary totals 20 product areas. Cost is for one run of every area. Medium effort
Mo has a 30-minute budget and high effort has 60.

| Time   | Agent                        | Findings | Correct | Incorrect | Unmatched | Dup. | Precision | Recall | Score  | Cost    | Cost per correct |
| ------ | ---------------------------- | -------- | ------- | --------- | --------- | ---- | --------- | ------ | ------ | ------- | ---------------- |
| 30 min | Mo                           | 161.98   | 114.34  | 26.34     | 17.66     | 3.65 | 81.3%     | 9.3%   | 249.65 | $287.92 | $2.52            |
| 30 min | Other agents (mean)          | 59.08    | 43.25   | 8.87      | 6.79      | 0.00 | 83.6%     | 3.5%   | 103.50 | $43.24  | $1.55            |
| 30 min | Lowest: Claude Sonnet 5.5    | 7.99     | 4.32    | 0.00      | 3.66      | 0.00 | 100.0%    | 0.5%   | 9.66   | $4.47   | $1.03            |
| 30 min | Highest: Codex `gpt-6.1-sol` | 97.68    | 82.33   | 7.32      | 7.99      | 0.00 | 91.8%     | 6.7%   | 214.33 | $46.22  | $0.56            |
| 60 min | Mo                           | 186.00   | 126.33  | 22.67     | 30.66     | 6.31 | 84.8%     | 10.3%  | 285.33 | $377.63 | $2.99            |
| 60 min | Other agents (mean)          | 62.04    | 47.24   | 9.00      | 5.49      | 0.13 | 85.2%     | 3.9%   | 113.75 | $60.72  | $1.71            |
| 60 min | Lowest: Claude Sonnet 5.5    | 8.30     | 4.64    | 0.33      | 3.33      | 0.00 | 93.4%     | 0.5%   | 8.99   | $5.99   | $1.29            |
| 60 min | Highest: Codex `gpt-6.1-sol` | 106.00   | 89.67   | 9.34      | 7.00      | 0.00 | 90.6%     | 7.3%   | 232.32 | $52.61  | $0.59            |

Lowest and highest are by Score, and both use Playwright MCP. Other agents covers
every non-Mo configuration in the CSV. Sonnet has results for 16 to 17 areas, and
some Codex configurations for 19, so their totals cover fewer areas.

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
area's scope and entry points, and the rule not to read benchmark files. Codex,
Claude Code and Devin are also told which browser to use and how to save
findings. Devin's prompt adds its
[isolation rules](src/agents/devin/README.md).

**Time.** `--minutes` (1 to 120) or `--time-limit` (such as `30m`) sets a limit,
stated in the brief. Without it, the brief states no limit and the run stops at
2 hours. A minute before the stop, each agent is told to save its work. Durations
exclude fixture setup and grading.

**Mo's budget.** `--effort low|medium|high|max` sets Mo's budget. It applies only
to Mo. Medium is 30 minutes and high is 60, compared with the other agents at
`--minutes 30` and `--minutes 60`.

**Agents.** Versions are pinned in [`package.json`](package.json).

| Agent       | Model and reasoning effort   | Browser                         |
| ----------- | ---------------------------- | ------------------------------- |
| Mo          | Chosen by Momentic's service | Hosted by Momentic              |
| Codex       | `gpt-6.1-sol`, medium        | Playwright MCP or agent-browser |
| Claude Code | `claude-opus-5-5`, medium    | Playwright MCP or agent-browser |
| Devin       | Devin's defaults             | Devin's native browser          |

Results also include Codex with `gpt-6.1-terra` and Claude Code with
`claude-sonnet-5-5`. Models are set in the agent adapters.

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
