# QA bench

Runs QA agents against seeded open-source apps and grades their bug reports
against labeled ground truth.

Agents: `mo` (through the `qa` CLI), `codex-playwright-mcp`, `claude-playwright-mcp` and `devin-qa`. Each fixture runs in
its own E2B sandbox. Codex and Claude drive a browser through Playwright MCP:
Browserbase by default, or a headless Chromium on the eval host with
`--browser local`. The run records its browser in `duration.json`, and `merge`
labels those rows, e.g. `codex-playwright-mcp (local browser)`.

Mo, Codex and Claude can use subagents. Mo runs its own subagents on Momentic's
service. Codex uses its multi-agent mode, and each Codex subagent starts its own
Playwright MCP server with its own Browserbase browser. Claude Code uses its
subagent tool; Claude shares one MCP connection across agents, so a loopback
proxy gives each subagent its own Playwright process and Browserbase browser.
For both, only the parent can save findings. With `--browser local`, Codex and
Claude run single-agent, since one local browser can't be shared. The run
records `subagents` in `duration.json`, and `merge` labels runs without them,
e.g. `claude-playwright-mcp (no subagents)`.

`devin-qa` uses Devin's default configuration and hosted browser, with VM
network restrictions and instructions against outside research. Built-in
retrieval relies on prompt compliance. See [Devin QA setup](src/agents/devin/README.md).

## Setup

Requires Node.js 22.12+ and pnpm.

```bash
pnpm install
pnpm build-template            # once per E2B org: Docker host template (2 CPU / 4 GiB)
pnpm build-template --cpu 4 --memory 8   # also once, for twenty
```

Environment:

| Variable | Used by |
| --- | --- |
| `E2B_API_KEY` | all runs |
| `OPENAI_API_KEY` | grading, `codex-playwright-mcp` |
| `BROWSERBASE_API_KEY` | `codex-playwright-mcp`, `claude-playwright-mcp` (not with `--browser local`) |
| `ANTHROPIC_API_KEY` | `claude-playwright-mcp` |
| `MOMENTIC_API_KEY` | `mo` (or sign in with `qa`) |
| `DEVIN_ORGANIZATION_ID`, `DEVIN_TOKEN` | `devin-qa` session and security-profile access |

`mo` runs on Momentic's hosted service and needs a Momentic account. Install
the CLI with `npm install -g qa@0.27.0` and sign in, or set
`MOMENTIC_API_KEY`. Set `MO_EVAL_CLI` to use another executable. Use
`--effort low|medium|high|max` to set Mo's effort preset (default: medium). An
explicit `--effort` is recorded in `duration.json`.

## Development

Run `pnpm lint`, `pnpm format:check` and `pnpm typecheck` before submitting
changes. CI runs the same checks. Use `pnpm lint:fix` and `pnpm format` to apply
automatic fixes to `src/`.

## Run

```bash
pnpm eval --agent mo --fixtures gitea --time-limit 2h
pnpm eval --agent codex-playwright-mcp --fixtures gitea/areas --time-limit 30m
pnpm eval --agent claude-playwright-mcp --grade-only --fixtures gitea
pnpm merge --fixtures gitea
```

`--fixtures` takes app names (`gitea`), one area (`gitea/areas/issues`), all
areas of an app (`gitea/areas`), or `oss-areas`. A whole-app run is graded
against the union of its area references.

Runs stop after 2h unless `--time-limit` or `--minutes` sets another limit.
Every agent sees the limit in its brief. Mo's own budget comes from `--effort`.

Reports go to `reports/<agent>/<fixture>/<run-id>/`. Each run writes
`scores.csv`, `grading.json` and a `review.md` queue of unmatched findings.

Every agent gets the same brief, built in `src/evals/bugbash-brief.ts`: the app
URL, test accounts, and the area's scope and entry points.

## Scoring

A judge model (GPT-6.1 Sol, high reasoning) matches each finding to the area's
`ground-truth.json` (known bugs) or `known-invalid.json` (known false reports).
Repeat reports of one bug count as duplicates. Anything else is unverified.
Duplicates and unverified findings are listed in `review.md`.

- Recall: known hits / known bugs in the area.
- Precision: correct reports / adjudicated reports. Duplicates count, so a
  repeat of a known bug is correct and a repeat of a known invalid finding is
  not. Unverified findings are excluded.
- Severity sum: each known bug has a severity of 1 (cosmetic), 3 (functional)
  or 5 (broken page or error dump). The sum counts each bug once.
- Score: severity sum minus known-invalid and duplicate findings.

The judge is a model, so regrading the same findings can change a few matches.
`--grade-only` regrades saved runs.

## Cost

Reported costs are directional. Codex and Claude costs are token estimates at
list prices plus Browserbase time. Mo cost is Momentic's billed session spend.
E2B sandbox time and grading calls are not included. Short test runs on one
area cost $1 to $5 per agent; full runs cost much more.

Start a fixture by hand with `pnpm start-fixture gitea --timeout 30m`; stop it
with `pnpm stop-fixture <sandbox-id>`.

## Fixtures

Each app lives under `fixtures/oss/<app>/`: a Compose recipe, seed scripts and
`e2e/areas/<area>/` with `fixture.json` (scope and entry points),
`ground-truth.json` and `known-invalid.json`.

## agent-browser variants

`codex-agent-browser` and `claude-agent-browser` use the pinned agent-browser CLI
and its official bundled skill in place of Playwright MCP. Use the same fixture,
time-limit and browser options. agent-browser declares Node.js 24+ support.

```bash
pnpm eval --agent codex-agent-browser --fixtures twenty/areas --time-limit 30m
pnpm eval --agent claude-agent-browser --fixtures twenty/areas --time-limit 30m
```

Codex's CLI variant uses a writable workspace with network access so the CLI can
create its browser socket. Each run owns its socket directory and Browserbase
connection; native agents choose how to use subagents, sessions and tabs.
