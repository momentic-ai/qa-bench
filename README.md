# QA bench

Runs QA agents against seeded open-source apps and grades their bug reports
against labeled ground truth.

Agents: `mo` (through the `qa` CLI), `codex` and `claude`. Each fixture runs in
its own E2B sandbox. Codex and Claude drive a Browserbase browser through
Playwright MCP.

## Setup

Requires Node.js 22.9+ and pnpm.

```bash
pnpm install
pnpm build-template            # once per E2B org: Docker host template (2 CPU / 4 GiB)
```

Environment:

| Variable | Used by |
| --- | --- |
| `E2B_API_KEY` | all runs |
| `OPENAI_API_KEY` | grading, `codex` |
| `BROWSERBASE_API_KEY` | `codex`, `claude` |
| `ANTHROPIC_API_KEY` | `claude` |

`mo` needs `qa` 0.24.0 or later, signed in. Set `MO_EVAL_CLI` to use another
executable.

## Run

```bash
pnpm eval --agent mo --fixtures gitea --time-limit 2h
pnpm eval --agent codex --fixtures gitea/areas --time-limit 30m
pnpm eval --agent claude --grade-only --fixtures gitea
pnpm merge --fixtures gitea
```

`--fixtures` takes app names (`gitea`), one area (`gitea/areas/issues`), all
areas of an app (`gitea/areas`), or `oss-areas`. A whole-app run is graded
against the union of its area references.

Reports go to `reports/<agent>/<fixture>/<run-id>/`. Each run writes
`scores.csv`, `grading.json` and a `review.md` queue of unmatched findings.

Start a fixture by hand with `pnpm start-fixture gitea --timeout 30m`; stop it
with `pnpm stop-fixture <sandbox-id>`.

## Fixtures

Each app lives under `fixtures/oss/<app>/`: a Compose recipe, seed scripts and
`e2e/areas/<area>/` with `fixture.json` (scope and entry points),
`ground-truth.json` and `known-invalid.json`.
