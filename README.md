# QA bench

A benchmark of AI QA agents finding real bugs in open-source web apps. It runs
Mo, Codex, Claude Code and Devin against 20 product areas of Gitea, Metabase,
Twenty and Saleor, then grades their bug reports against 1,396 human-reviewed
bug labels. Results: [momentic.ai/qa-bench](https://momentic.ai/qa-bench).
Write-up: [momentic.ai/blog/qa-bench](https://momentic.ai/blog/qa-bench).

Momentic builds Mo and maintains this benchmark.

The labeled fixtures are published as the
[momentic/qa-bench](https://huggingface.co/datasets/momentic/qa-bench) dataset
on Hugging Face, with [`DATASET_CARD.md`](DATASET_CARD.md) as its README. To
publish, run the Hugging Face sync workflow from `main` in GitHub Actions.

Each run gets a fresh copy of the app at a pinned commit, with seeded data, in
its own E2B sandbox. Codex and Claude Code drive hosted Browserbase browsers, not
local ones. Devin uses its own browser, and Mo uses Momentic's hosted browsers.
Areas live in [`fixtures/oss`](fixtures/oss).

| App      | Areas | Labeled bugs |
| -------- | ----- | ------------ |
| Gitea    | 11    | 476          |
| Metabase | 4     | 464          |
| Twenty   | 4     | 374          |
| Saleor   | 1     | 82           |
| Total    | 20    | 1,396        |

## Results

Graded with the labels and grader at `e77c72b`. Later grader changes aren't
reflected. Per-area results are in
[`results/2026-11-02.csv`](results/2026-11-02.csv). The dataset is on
[Hugging Face](https://huggingface.co/datasets/momentic/qa-bench).

| Configuration                           | Areas | Correct, 30 min | Correct, 60 min | Recall, 60 min | Precision, 60 min | Score, 60 min | Cost per correct, 60 min |
| --------------------------------------- | ----- | --------------- | --------------- | -------------- | ----------------- | ------------- | ------------------------ |
| Mo                                      | 20    | 176.7           | 269.3           | 19.3%          | 84.2%             | 588.7         | $2.67                    |
| Codex, GPT-6.1 Sol, Playwright MCP      | 20    | 74.7            | 86.3            | 6.2%           | 86.0%             | 207.0         | $0.80                    |
| Codex, GPT-6.1 Sol, e2e\*               | 20    | 77.3            | 83.7            | 6.0%           | 90.3%             | 205.6         | $2.08                    |
| Codex, GPT-6.1 Terra, Playwright MCP    | 20    | 83.3            | 82.7            | 5.9%           | 81.6%             | 177.0         | $0.53                    |
| Codex, GPT-6.1 Sol, agent-browser       | 20    | 68.0            | 64.3            | 4.6%           | 76.3%             | 144.3         | $0.96                    |
| Claude Code, Opus 5.5, Playwright MCP   | 20    | 38.0            | 59.0            | 4.2%           | 79.5%             | 122.7         | $4.09                    |
| Codex, GPT-6.1 Terra, agent-browser     | 20    | 59.3            | 57.7            | 4.1%           | 76.2%             | 126.3         | $0.27                    |
| Claude Code, Opus 5.5, e2e\*            | 20    | 39.4            | 57.3            | 4.1%           | 89.6%             | 127.3         | $8.98                    |
| Claude Code, Opus 5.5, agent-browser    | 20    | 24.0            | 41.0            | 2.9%           | 77.0%             | 81.0          | $2.45                    |
| Devin                                   | 20    | 16.0            | 27.0            | 1.9%           | 84.4%             | 65.0          | $3.89                    |
| Claude Code, Sonnet 5.5, Playwright MCP | 20    | 12.0            | 15.0            | 1.1%           | 72.6%             | 26.7          | $2.08                    |
| Claude Code, Sonnet 5.5, agent-browser  | 20    | 8.7             | 13.0            | 0.9%           | 65.0%             | 20.0          | $0.68                    |

Every configuration covers all 20 areas. Correct is summed over them, and
Recall divides it by the 1,396 labels. Devin ran each area once per budget; the
other configurations ran each area three times per budget, except Codex with
e2e on Gitea repository settings at 60 minutes. OpenAI's cybersecurity policy
refused one of those runs three times, so that area has two.

\* Pending label review. The e2e runs left 106 distinct findings (135 reports)
that match no label; the other rows have none. Reviewing them will raise
Correct and Recall where they are real bugs, and can lower Precision and Score
where they are invalid.

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
[`qa` CLI](https://www.npmjs.com/package/qa). Runs require version 0.32.0:

```bash
npm install -g qa@0.32.0
```

Run one agent on one area, then compare saved runs:

```bash
pnpm eval --agent codex-playwright-mcp --prevent-cheating --fixtures saleor/areas/vouchers --minutes 30
pnpm merge --fixtures saleor/areas/vouchers
```

`--agent` takes `mo`, `codex-playwright-mcp`, `claude-playwright-mcp`,
`codex-agent-browser`, `claude-agent-browser`, `codex-e2e`, `claude-e2e` or
`devin-qa`. `--fixtures` takes an app (`gitea`), all of its areas
(`gitea/areas`), one area, or `oss-areas`.

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

| Agent       | Model and reasoning effort   | Browser                                              |
| ----------- | ---------------------------- | ---------------------------------------------------- |
| Mo          | Chosen by Momentic's service | Hosted by Momentic                                   |
| Codex       | `gpt-6.1-sol`, medium        | Playwright MCP, agent-browser or e2e, on Browserbase |
| Claude Code | `claude-opus-5-5`, medium    | Playwright MCP, agent-browser or e2e, on Browserbase |
| Devin       | Devin's defaults             | Devin's native browser                               |

Results also include Codex with `gpt-6.1-terra` and Claude Code with
`claude-sonnet-5-5`. Use `--model` to run them.

### Browsers and subagents

- `codex-agent-browser` runs without Codex's sandbox, because the sandbox kills
  the agent-browser daemon after each command on Linux. Its shell can write
  anywhere your user can, so run it on a machine or VM you're happy to expose.
- `*-playwright-mcp` agents use Playwright MCP on Browserbase. The parent and
  each subagent get their own Browserbase browser.
- `*-agent-browser` agents use the pinned
  [agent-browser](https://www.npmjs.com/package/agent-browser) CLI and its
  bundled skill. Each run connects to one Browserbase browser, and the agent
  decides how to share it.
- `*-e2e` agents run a bug bash with the pinned
  [e2e](https://www.npmjs.com/package/e2e) CLI and its bundled skill: they plan
  charters, run `e2e explore` for each, and save the bugs that a failing repro
  test confirms. The workspace's `e2e.config.ts` sets the fixture URL, the
  browser, the model, the fixture accounts as e2e credentials (passwords come
  from the environment), and video recording. e2e's own agent uses the coding
  agent's model at medium effort, and each e2e process gets its own Browserbase
  browser. e2e
  needs Node.js 22.22.3 or later 22.x, or 24.8 or later. Like
  `codex-agent-browser`, these runs have no shell sandbox.
- `--browser local` replaces Browserbase with headless Chromium on the host.
  Playwright MCP runs then have no subagents, and `merge` labels them separately.
- Mo manages its own subagents, and `--max-concurrent-sub-agents` caps them.
  Devin runs in one session with no child sessions.

### Web access

Coding agents can search the web and find examples of these bugs online instead
of testing the fixture against its intended behavior. We recommend
`--prevent-cheating` for Codex and Claude Code runs. The flag is off by
default so new runs stay comparable with saved ones, and `merge` labels runs
that use it separately.

The flag turns off Codex web search, makes Playwright MCP refuse the sites in
`ANSWER_DOMAINS` ([`testing-browser.ts`](src/agents/testing-browser.ts)), limits
Browserbase pages to the fixture host, and tells the agent to record a blocked site
as a coverage limitation. Playwright MCP runs already use Codex's read-only
sandbox, which has no network access.

Claude Code already omits WebSearch and WebFetch from its tool list. With the flag, it also applies the browser restrictions above. Shared agent-browser sessions are kept alive across disconnects. Browserbase sessions get the requested time budget plus two minutes, up to the provider's six-hour limit.

The flag doesn't stop fixtures that fetch from code hosts on the server, such
as Gitea's "New Migration" from GitHub.

**`--prevent-cheating` is not a network firewall for agent-browser or e2e runs.** The flag
is accepted there, but it only turns off web search and, on Browserbase, limits
page navigation to the fixture host. With `--browser local` its browser isn't
restricted, and it runs without Codex's sandbox on any browser, so the agent can
still `curl` GitHub or the dataset. To run it without answer lookups, restrict the network outside
qa-bench. On Linux, run `pnpm eval` under
[nsjail](https://github.com/google/nsjail) or a similar sandbox with egress
limited to the hosts the run needs (the fixture, OpenAI, E2B and Browserbase).
On macOS, where nsjail doesn't run, do the same inside a Linux VM or container
(for example Docker or OrbStack) with an egress firewall.

## Scoring

A judge model (`gpt-6.1-sol`, high reasoning) compares each
finding with the area's [labels](#labels) and classifies each finding on its
own:

| Result    | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| Correct   | Matches a label in `ground-truth.json`. Each label counts once        |
| Incorrect | Matches a rejected claim in `known-invalid.json`                      |
| Unmatched | Matches neither. It may be a new bug, and is neither right nor wrong  |
| Dup.      | Repeats a match: same label or rejected claim, through the same steps |

Findings that match another area's labels are recorded separately and left out
of every metric below. The judge is a model, so regrading can change a few
matches. Its full prompt is in
[`grading-contract.ts`](src/grading/grading-contract.ts). `pnpm grader-eval`
checks the judge against reviewed findings in
[`cases.json`](src/grading/eval/cases.json).

| Metric           | Definition                                                           |
| ---------------- | -------------------------------------------------------------------- |
| Findings         | Every submitted finding                                              |
| Precision        | Findings matching a label / (those + Incorrect), duplicates included |
| Recall           | Correct / labels in the area                                         |
| Score            | Severity of Correct labels − Incorrect − Dup.                        |
| Cost per run     | Mean cost of a run                                                   |
| Cost per correct | Cost / Correct                                                       |

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
for Correct, Incorrect, Unmatched and Dup. `extra_known_hits` counts further
findings of an already-found label.

## Labels

Each area in `fixtures/oss/<app>/e2e/areas/<area>/` has:

- `fixture.json`: scope and entry points
- `ground-truth.json`: confirmed bugs
- `known-invalid.json`: rejected claims
