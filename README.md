# QA bench

Runs QA agents against seeded open-source apps and grades their bug reports
against labeled ground truth.

Agents: `mo` (through the `qa` CLI), `codex` and `claude`. Each fixture runs in
its own E2B sandbox. Codex and Claude drive a browser through Playwright MCP:
Browserbase by default, or a headless Chromium on the eval host with
`--browser local`. The run records its browser in `duration.json`, and `merge`
labels those rows, e.g. `codex (local browser)`.

All three agents can use subagents. Mo runs its own subagents on Momentic's
service. Codex uses its multi-agent mode, and each Codex subagent starts its own
Playwright MCP server with its own Browserbase browser. Claude Code uses its
subagent tool; Claude shares one MCP connection across agents, so a loopback
proxy gives each subagent its own Playwright process and Browserbase browser.
For both, only the parent can save findings. With `--browser local`, Codex and
Claude run single-agent, since one local browser can't be shared. The run
records `subagents` in `duration.json`, and `merge` labels runs without them,
e.g. `claude (no subagents)`.

## Setup

Requires Node.js 22.9+ and pnpm.

```bash
pnpm install
pnpm build-template            # once per E2B org: Docker host template (2 CPU / 4 GiB)
pnpm build-template --cpu 4 --memory 8   # also once, for twenty
```

Environment:

| Variable | Used by |
| --- | --- |
| `E2B_API_KEY` | all runs |
| `OPENAI_API_KEY` | grading, `codex` |
| `BROWSERBASE_API_KEY` | `codex`, `claude` (not with `--browser local`) |
| `ANTHROPIC_API_KEY` | `claude` |
| `MOMENTIC_API_KEY` | `mo` (or sign in with `qa`) |

`mo` runs on Momentic's hosted service and needs a Momentic account. Install
the CLI with `npm install -g qa` (0.27.0 or later) and sign in, or set
`MOMENTIC_API_KEY`. Set `MO_EVAL_CLI` to use another executable. Use
`--effort low|medium|high|max` to set Mo's effort preset (default: medium);
it is recorded in `duration.json`.

## Run

```bash
pnpm eval --agent mo --fixtures gitea
pnpm eval --agent codex --fixtures gitea/areas
pnpm eval --agent claude --grade-only --fixtures gitea
pnpm merge --fixtures gitea
```

`--fixtures` takes app names (`gitea`), one area (`gitea/areas/issues`), all
areas of an app (`gitea/areas`), or `oss-areas`. A whole-app run is graded
against the union of its area references.

Reports go to `reports/<agent>/<fixture>/<run-id>/`. Each run writes
`scores.csv`, `grading.json` and a `review.md` queue of unmatched findings.

Runs stop after 2 hours if the agent hasn't finished. Agents aren't told this
limit up front; 15 minutes before it, every agent gets one wrap-up message.

Every agent gets the same brief, built in `src/evals/bugbash-brief.ts`: the app
URL, test accounts, the area's scope and entry points, and the reporting rules.

## Scoring

A judge model (GPT-6.1 Sol, high reasoning) matches each finding to the area's
`ground-truth.json` (known bugs) or `known-invalid.json` (known false reports).
Repeat reports of one bug count as duplicates. Anything else is unverified.
Duplicates and unverified findings are listed in `review.md`.

- Recall: known hits / known bugs in the area.
- Precision: known hits / (known hits + known invalid). Unverified findings
  are excluded.
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
