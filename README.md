# QA bench

Runs QA agents against seeded open-source apps and grades their bug reports
against labeled ground truth.

Agents: `mo` (through the `qa` CLI), `codex-playwright-mcp` and `claude-playwright-mcp`. Each fixture runs in
its own E2B sandbox. Codex and Claude drive a browser through Playwright MCP:
Browserbase by default, or a headless Chromium on the eval host with
`--browser local`. The run records its browser in `duration.json`, and `merge`
labels those rows, e.g. `codex-playwright-mcp (local browser)`.

All three agents can use subagents. Mo runs its own subagents on Momentic's
service. Codex uses its multi-agent mode, and each Codex subagent starts its own
Playwright MCP server with its own Browserbase browser. Claude Code uses its
subagent tool; Claude shares one MCP connection across agents, so a loopback
proxy gives each subagent its own Playwright process and Browserbase browser.
For both, only the parent can save findings. With `--browser local`, Codex and
Claude run single-agent, since one local browser can't be shared. The run
records `subagents` in `duration.json`, and `merge` labels runs without them,
e.g. `claude-playwright-mcp (no subagents)`.

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
| `OPENAI_API_KEY` | grading, `codex-playwright-mcp` |
| `BROWSERBASE_API_KEY` | `codex-playwright-mcp`, `claude-playwright-mcp` (not with `--browser local`) |
| `ANTHROPIC_API_KEY` | `claude-playwright-mcp` |

`mo` needs `qa` 0.27.0 or later, signed in. Set `MO_EVAL_CLI` to use another
executable. Use `--effort low|medium|high|max` to set Mo's effort preset
(default: medium). An explicit `--effort` is recorded in `duration.json`.

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
Mo gets that limit as its time budget only when one is passed; otherwise it
uses its default budget.

Reports go to `reports/<agent>/<fixture>/<run-id>/`. Each run writes
`scores.csv`, `grading.json` and a `review.md` queue of unmatched findings.

Start a fixture by hand with `pnpm start-fixture gitea --timeout 30m`; stop it
with `pnpm stop-fixture <sandbox-id>`.

## Fixtures

Each app lives under `fixtures/oss/<app>/`: a Compose recipe, seed scripts and
`e2e/areas/<area>/` with `fixture.json` (scope and entry points),
`ground-truth.json` and `known-invalid.json`.
