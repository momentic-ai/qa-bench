# QA bench

A benchmark of AI QA agents finding real bugs in open-source web apps. It runs
Mo, Codex, Claude Code and Devin against product areas of Metabase, Saleor
(vouchers), Gitea and Twenty, then grades their bug reports against
human-reviewed labels.

Momentic builds Mo and maintains this benchmark.

The labeled fixtures are published as the
[momentic/qa-bench](https://huggingface.co/datasets/momentic/qa-bench) dataset
on Hugging Face. To publish, run the Hugging Face sync workflow from `main` in
GitHub Actions.

Each run gets a fresh copy of the app at a pinned commit, with seeded data, in
its own E2B sandbox. Areas live in [`fixtures/oss`](fixtures/oss).

## Results

Per-area results are in [`results/2026-10-30.csv`](results/2026-10-30.csv).

| Configuration                           | Areas   | Correct, 30 min | Correct, 60 min | Recall, 60 min | Precision, 60 min | Score, 60 min | Cost per correct, 60 min |
| --------------------------------------- | ------- | --------------- | --------------- | -------------- | ----------------- | ------------- | ------------------------ |
| Mo                                      | 20      | 146.3           | 242.0           | 19.6%          | 84.4%             | 533.7         | $2.98                    |
| Codex, GPT-6.1 Sol, Playwright MCP      | 20      | 81.0            | 89.0            | 7.2%           | 91.1%             | 230.3         | $0.59                    |
| Codex, GPT-6.1 Sol, agent-browser       | 20 / 19 | 68.0            | 69.3            | 5.8%           | 80.0%             | 163.3         | $1.08                    |
| Codex, GPT-6.1 Terra, Playwright MCP    | 19      | 75.7            | 69.0            | 5.8%           | 78.7%             | 154.7         | $0.55                    |
| Codex, GPT-6.1 Terra, agent-browser     | 19      | 58.0            | 52.0            | 4.3%           | 80.8%             | 125.0         | $0.31                    |
| Claude Code, Opus 5.5, Playwright MCP   | 20      | 21.7            | 34.6            | 2.8%           | 86.0%             | 79.7          | $3.19                    |
| Claude Code, Opus 5.5, agent-browser    | 20      | 18.0            | 30.7            | 2.5%           | 85.2%             | 76.7          | $2.68                    |
| Devin                                   | 20      | 16.0            | 27.0            | 2.2%           | 84.4%             | 65.0          | $3.89                    |
| Claude Code, Sonnet 5.5, Playwright MCP | 20      | 5.3             | 7.7             | 0.6%           | 88.5%             | 15.3          | $1.46                    |
| Claude Code, Sonnet 5.5, agent-browser  | 20      | 9.0             | 6.3             | 0.5%           | 79.3%             | 12.7          | $1.24                    |

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
pnpm eval --agent codex-playwright-mcp --prevent-cheating --fixtures saleor/areas/vouchers --minutes 30
pnpm merge --fixtures saleor/areas/vouchers
```

`--agent` takes `mo`, `codex-playwright-mcp`, `claude-playwright-mcp`,
`codex-agent-browser`, `claude-agent-browser` or `devin-qa`. `--fixtures` takes
an app (`gitea`), all of its areas (`gitea/areas`), one area, or `oss-areas`.

Each run is graded when it finishes and saved to
`reports/<agent>/<fixture>/<run-id>/`. `merge` writes `reports/comparison.md`.

## Methodology

### Brief

Every agent gets the same short brief from
[`bugbash-brief.ts`](src/evals/bugbash-brief.ts): the app URL, test accounts, the
area's scope and entry points, and the rule not to read benchmark files. Codex,
Claude Code and Devin are also told which browser to use and how to save
findings. Devin's prompt adds its
[isolation rules](src/agents/devin/README.md).

### Time

`--minutes` (1 to 120) or `--time-limit` (such as `30m`) sets a limit,
stated in the brief. Without it, the brief states no limit and the run stops at
2 hours. In runs longer than a minute, each agent is told to save its work a
minute before the stop. Durations exclude fixture setup and grading.

### Mo's budget

`--effort low|medium|high|max` sets Mo's budget. It applies only
to Mo.

### Agents

Versions are pinned in [`package.json`](package.json).

| Agent       | Model and reasoning effort   | Browser                         |
| ----------- | ---------------------------- | ------------------------------- |
| Mo          | Chosen by Momentic's service | Hosted by Momentic              |
| Codex       | `gpt-6.1-sol`, medium        | Playwright MCP or agent-browser |
| Claude Code | `claude-opus-5-5`, medium    | Playwright MCP or agent-browser |
| Devin       | Devin's defaults             | Devin's native browser          |

Results also include Codex with `gpt-6.1-terra` and Claude Code with
`claude-sonnet-5-5`. Use `--model` to run them.

### Browsers and subagents

- `*-playwright-mcp` agents use Playwright MCP on Browserbase. The parent and
  each subagent get their own Browserbase browser.
- `*-agent-browser` agents use the pinned
  [agent-browser](https://www.npmjs.com/package/agent-browser) CLI and its
  bundled skill. Each run connects to one Browserbase browser, and the agent
  decides how to share it.
- `--browser local` replaces Browserbase with headless Chromium on the host.
  Playwright MCP runs then have no subagents, and `merge` labels them separately.
- Mo manages its own subagents, and `--max-concurrent-sub-agents` caps them.
  Devin runs in one session with no child sessions.

### Web access

We recommend `--prevent-cheating` for every `codex-playwright-mcp` run. Without
it, we've seen Codex search the web and find examples of the bugs online instead
of testing the fixture against its intended behavior. The flag is off by default
so new runs stay comparable with saved ones, and `merge` labels runs that use it
separately.

The flag turns off Codex web search, makes Playwright MCP refuse the sites in
`ANSWER_DOMAINS` ([`codex-agent.ts`](src/agents/codex/codex-agent.ts)), limits
Browserbase pages to the fixture host, and tells Codex to record a blocked site
as a coverage limitation. Playwright MCP runs already use Codex's read-only
sandbox, which has no network access.

**`codex-agent-browser` does not support `--prevent-cheating`.** There the flag
only turns off web search and, on Browserbase, limits page navigation to the
fixture host. With `--browser local` its browser isn't restricted, and its
shell keeps network access on any browser, so the agent can still `curl` GitHub
or the dataset. To run it without answer lookups, restrict the network outside
qa-bench. On Linux, run `pnpm eval` under
[nsjail](https://github.com/google/nsjail) or a similar sandbox with egress
limited to the hosts the run needs (the fixture, OpenAI, E2B and Browserbase).
On macOS, where nsjail doesn't run, do the same inside a Linux VM or container
(for example Docker or OrbStack) with an egress firewall.

## Scoring

A judge model (`gpt-6.1-sol`, high reasoning) compares each
finding with the area's [labels](#labels). It first groups reports of the same
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

Costs:

- Codex is token usage at list prices, plus estimated Browserbase time.
- Claude Code is the cost reported by the Agent SDK, plus estimated Browserbase
  time.
- Mo is its reported session spend.
- Devin's cost isn't recorded by this repo. Its figures were calculated
  separately.

E2B and grading aren't included in cost.

`scores.csv` uses `known_hits`, `known_invalid`, `unverified` and `duplicates`
for Correct, Incorrect, Unmatched and Dup. Its `precision` field also counts
duplicates of classified findings, so it can differ from the definition above.

## Labels

Each area in `fixtures/oss/<app>/e2e/areas/<area>/` has:

- `fixture.json`: scope and entry points
- `ground-truth.json`: confirmed bugs
- `known-invalid.json`: rejected claims
