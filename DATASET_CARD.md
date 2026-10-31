---
pretty_name: QA-Bench
size_categories:
  - 1K<n<10K
task_categories:
  - other
tags:
  - qa
  - bug-finding
  - exploratory-testing
  - browser-agents
  - web-apps
  - agent-evaluation
license: mit
---

# QA-Bench

A benchmark for autonomous QA agents. An agent gets a running copy of a real
open-source web app and a brief for one product area, then has to find and
report bugs. Its reports are graded against human-reviewed ground truth.

This dataset is a sample of Momentic's full QA benchmark. The public harness and
sample fixtures live in
[momentic-ai/qa-bench](https://github.com/momentic-ai/qa-bench), which
publishes this dataset.

## Dataset at a glance

- **20 annotated product areas across 4 open-source apps**: Gitea, Metabase,
  Saleor and Twenty, each pinned to an upstream commit and seeded with
  deterministic data.
- **Over 1,800 labels**: confirmed bugs, plus known-invalid reports (findings
  agents have made that were checked and rejected, used to penalize false
  positives). Each area also has a brief with its scope and entry points.
- **Severity**: each bug is 1 (cosmetic), 3 (functional) or 5 (broken page or
  error dump).
- **Domains**: code hosting, BI/analytics, e-commerce admin, CRM and workflows.
- **Labels** start as candidate reports from agent runs, and a person approves
  or rejects each one. In current rounds, Mo also reproduces each candidate,
  and Claude Code and Codex check it independently in the browser and the
  source.

| App | Upstream | Product areas |
| --- | --- | --- |
| Gitea | `go-gitea/gitea` | Issues; Labels; Milestones; Notifications and watching; Profiles and account settings; Pull requests; Releases and tags; Repository code; Repository management and policies; Site administration; Wiki |
| Metabase | `metabase/metabase` | Admin; Dashboards; Data modeling; Querying |
| Saleor | `saleor/saleor` + `saleor/saleor-dashboard` | Vouchers |
| Twenty | `twentyhq/twenty` | Record pages and activities; Record lists and views; Settings and data model; Workflows |

## Structure

Each app is a top-level folder:

```
<app>/
  compose.yaml          # pinned images and services
  fixture.json          # port, test accounts, upstream repo + commit
  runtime/              # seed and snapshot scripts, seed data
  e2e/areas/<area>/
    fixture.json        # area name, scope, entry points
    ground-truth.json   # known bugs
    known-invalid.json  # known false reports
```

**`fixture.json` (area)**: `productArea.name`, a `scope` paragraph saying what
is in and out of bounds, and `entryPoints` (a path plus directions). This is
what the agent sees.

**`ground-truth.json` / `known-invalid.json`**: `{ "bugs": [...] }`, where
each entry has:

| Field | Description |
| --- | --- |
| `name` | Short title |
| `summary` | One-sentence description |
| `expected` | Correct behavior |
| `actual` | Observed behavior on the seeded data |
| `reproSteps` | Ordered steps from the entry point |
| `severity` | 1, 3 or 5 (ground truth only) |
| `matchingGuidance`, `matchingScope`, `owningArea`, ... | Optional hints for the judge on which reports count as this bug |

## The task

Given the app URL, test accounts and an area brief (scope and entry points),
explore the app in a browser and report bugs. A report has the same core shape
as a ground-truth entry. Every agent gets the same brief and the same time limit
(2h by default), runs in its own E2B sandbox, and is told not to read benchmark
files, ground truth or earlier eval reports.

Agents evaluated so far: Mo, Codex and Claude Code through Playwright MCP or
agent-browser, and Devin.

## Scoring

A judge model matches each report to a ground-truth bug, a known-invalid entry,
or neither (unverified). Repeat reports of one bug are duplicates.

- **Recall**: known bugs found / known bugs in the area.
- **Precision**: correct reports / adjudicated reports. Duplicates count;
  unverified reports are excluded.
- **Severity sum**: severity of each distinct known bug found.
- **Score**: severity sum minus known-invalid and duplicate reports.

Unverified reports go to a `review.md` queue. Approved ones become new ground
truth, so the label set grows with each round.

## Usage

```bash
hf download momentic/qa-bench --repo-type dataset --local-dir qa-bench
```

```python
import json
from pathlib import Path

for area in sorted(Path("qa-bench").glob("*/e2e/areas/*")):
    brief = json.loads((area / "fixture.json").read_text())["productArea"]
    bugs = json.loads((area / "ground-truth.json").read_text())["bugs"]
    invalid = json.loads((area / "known-invalid.json").read_text())["bugs"]
    print(f"{area.parts[1]}/{brief['name']}: {len(bugs)} bugs, {len(invalid)} known invalid")
```

To run agents and grade them, use the harness from
[GitHub](https://github.com/momentic-ai/qa-bench):

```bash
pnpm install
pnpm build-template
pnpm eval --agent mo --fixtures gitea/areas/issues --time-limit 30m
pnpm eval --agent claude-playwright-mcp --fixtures gitea/areas/issues --time-limit 30m
pnpm merge --fixtures gitea/areas/issues
```

`--fixtures` takes an app (`gitea`), one area (`gitea/areas/issues`), all areas
of an app (`gitea/areas`), or `oss-areas`. Each run writes `scores.csv`,
`grading.json` and `review.md`; `merge` compares every agent's latest scores on
the same fixtures in `reports/comparison.md`. See the repo README for API keys
and agent setup.

## Provenance & disclosure

- This is a sample of Momentic's full QA benchmark.
- Apps run at pinned upstream commits and image digests; the bugs are real
  defects in those versions, not injected ones.
- Labels come from agent runs, so ground truth may share blind spots with the
  agents being evaluated. Recall is relative to what has been found and
  reviewed, not to every bug in the app.
- The judge is a model; regrading the same reports can change a few matches.
- Built and maintained by Momentic, which also builds Mo, one of the evaluated
  agents.

## License

The labels, briefs and seed scripts are released under the MIT license. The
dataset contains no upstream source or binaries; `compose.yaml` pulls each
app's official image by digest. The apps keep their own licenses: Gitea MIT,
Saleor BSD-3-Clause, and Metabase and Twenty AGPL-3.0 with commercially
licensed enterprise code.

## Citation

```bibtex
@misc{qabench2026,
  title  = {QA-Bench: Evaluating Autonomous QA Agents on Real Web Applications},
  author = {Momentic},
  year   = {2026}
}
```
