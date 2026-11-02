---
pretty_name: QA-Bench
language:
  - en
license: mit
size_categories:
  - 1K<n<10K
task_categories:
  - other
annotations_creators:
  - machine-generated
  - expert-generated
source_datasets:
  - original
tags:
  - benchmark
  - qa
  - software-testing
  - bug-finding
  - exploratory-testing
  - browser-agents
  - web-apps
  - agent-evaluation
viewer: false
---

# QA-Bench

A benchmark for autonomous QA agents. An agent gets a running copy of a real
open-source web application and a brief for one product area, then has a fixed
amount of time to find and report bugs. Its reports are graded against a
human-reviewed set of known bugs, so any agent that can drive a browser, whether
a dedicated testing agent or a general coding agent, can be scored on the same
workload.

This is the full benchmark: every application, area, brief, and label used in
Momentic's published results. The harness that runs and grades agents lives in
[momentic-ai/qa-bench](https://github.com/momentic-ai/qa-bench), which
publishes this dataset. Results are at
[momentic.ai/qa-bench](https://momentic.ai/qa-bench).

## Dataset at a glance

- **4 open-source web applications**, each pinned to an upstream commit and
  seeded with deterministic data: Gitea (code hosting), Metabase (BI and
  analytics), Saleor (e-commerce admin), and Twenty (CRM and workflows).
- **20 product areas**, each with a brief that sets its scope and entry points.
- **1,396 confirmed bugs**, plus 501 known-invalid reports: findings an agent
  made that a reviewer checked and rejected. The grader uses them to penalize
  false positives.
- **Severity** on every confirmed bug: 1 (cosmetic), 3 (functional), or 5
  (broken page or error dump).
- **Real defects.** The bugs exist in the pinned application versions. None
  were injected.

| App      | Upstream                                    | Product areas                                                                                                                                                                                           | Confirmed bugs |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Gitea    | `go-gitea/gitea`                            | Issues; Labels; Milestones; Notifications and watching; Profiles and account settings; Pull requests; Releases and tags; Repository code; Repository management and policies; Site administration; Wiki | 476            |
| Metabase | `metabase/metabase`                         | Admin; Dashboards; Data modeling; Querying                                                                                                                                                              | 464            |
| Twenty   | `twentyhq/twenty`                           | Record pages and activities; Record lists and views; Settings and data model; Workflows                                                                                                                 | 374            |
| Saleor   | `saleor/saleor` + `saleor/saleor-dashboard` | Vouchers                                                                                                                                                                                                | 82             |

## Versioning

The labels grow as new findings are reviewed, so results are only comparable
when graded against the same label set. Momentic's published results use the
labels at GitHub commit `e77c72b7ad024366ba194f0c3cc36a93c6209349`, and this
repository mirrors the GitHub tree. Pin a Hugging Face revision when you report
results, and cite it alongside the scores. Every score file the harness writes
carries a hash of the judge configuration and the label files it was graded
against.

## Structure

Each application is a top-level folder. The files at the top level build the
sandbox, and each area folder under `e2e/areas/` holds the brief and the labels
for that area. There are no train, validation, or test splits.

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

The area `fixture.json` is the brief the agent sees. It holds
`productArea.name`, a `scope` paragraph on what is in and out of bounds, and
`entryPoints`, each a path into the app plus directions for getting started
there.

`ground-truth.json` and `known-invalid.json` both hold `{ "bugs": [...] }`.
Each entry has:

| Field                                                  | Description                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `name`                                                 | Short title                                                     |
| `summary`                                              | One-sentence description                                        |
| `expected`                                             | Correct behavior                                                |
| `actual`                                               | Observed behavior on the seeded data                            |
| `reproSteps`                                           | Ordered steps from the entry point                              |
| `severity`                                             | 1, 3, or 5 (ground truth only)                                  |
| `matchingGuidance`, `matchingScope`, `owningArea`, ... | Optional hints for the judge on which reports count as this bug |

An entry from `gitea/e2e/areas/pull-requests/ground-truth.json`, with its optional
matching hints left out:

```json
{
  "name": "Deleting a discussion comment leaves the conversation count stale",
  "summary": "Deleting a PR discussion comment removes it from the timeline but leaves the Conversation badge unchanged until reload.",
  "expected": "The Conversation count reflects a completed discussion-comment deletion immediately.",
  "actual": "The sole comment disappears while Conversation still shows 1; reload shows 0. Deleting one of several comments also leaves the old count. Locked and unlocked PRs reproduce.",
  "reproSteps": [
    "Create a disposable PR and post a discussion comment.",
    "Note the Conversation count and delete that comment through its menu.",
    "Observe the comment is absent but the badge retains the previous count.",
    "Reload and confirm the corrected count."
  ],
  "severity": 1
}
```

The seed data, test accounts, and credentials in `fixture.json` and `runtime/`
are synthetic. The dataset contains no personal data.

## The task

Given the application URL, test accounts, and area brief, the agent explores the
area in a browser and reports any bugs it finds. A report has the same core
fields as a ground-truth entry: a name, a summary, expected and actual
behavior, and reproduction steps.

Every agent gets the same brief and time limit and runs in its own E2B sandbox.
During a run, it can't read the application source, the benchmark files, the
ground truth, or earlier reports, and it has no internet access beyond the
application under test. The published runs had two exceptions (see [Web
access](https://github.com/momentic-ai/qa-bench#web-access)): Codex web search
was on, including in Playwright MCP runs, and in the Codex and Claude Code
agent-browser runs the agent's shell had open web access. The harness defaults
to a 2-hour limit (`--time-limit`); Momentic's published runs used 30 and 60
minutes.

Agents evaluated so far: Mo (hosted by Momentic), Codex and Claude Code (each
through Playwright MCP or agent-browser on a hosted Browserbase browser, not a
local one), and Devin (its native browser). In
Momentic's 60-minute runs, Mo matched 17.9% of the 1,396 labeled bugs per pass,
against 6.8% for the best Codex configuration, 2.8% for the best Claude Code
configuration, and 1.9% for Devin.
Per-configuration results are in the
[GitHub README](https://github.com/momentic-ai/qa-bench#results).

## Scoring

A judge model matches each report to a ground-truth bug, a known-invalid entry,
or neither. Repeat reports of one bug in the same run are duplicates.

- **Recall**: distinct known bugs found / known bugs in the area. Reporting a
  bug twice counts once.
- **Precision**: reports that matched a known bug / reports that matched a
  known bug or a known-invalid entry.
- **Severity sum**: the severity weights of the distinct known bugs found,
  added up.
- **Score**: severity sum, minus one point for each known-invalid report and
  each duplicate.

Reports that match neither list go to a `review.md` queue. A reviewer labels
each one as a new bug or a known-invalid report, so the label set grows with
each round. In the published results, every report has been reviewed and
counts as one or the other.

## Usage

```bash
hf download momentic/qa-bench --repo-type dataset --local-dir qa-bench
```

The dataset is a folder tree rather than a table, so iterate over the area
folders:

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
`grading.json`, and `review.md`; `merge` compares every agent's latest scores on
the same fixtures in `reports/comparison.md`. See the repo README for API keys
and agent setup.

## Provenance and disclosure

- Apps run at pinned upstream commits and image digests, so a run today sees
  the same application the labels describe.
- Labels are agent-drafted and human-reviewed. Candidate bugs come from
  exploratory runs by Mo, Claude Code, and Codex. Mo reproduces each candidate,
  Claude Code and Codex check it independently in the browser and in the
  application source, and a person approves or rejects it. Approved candidates
  become ground truth and rejected ones become known-invalid entries.
- Because the candidates come from agents, the ground truth may share blind
  spots with the agents being evaluated. Recall is relative to what has been
  found and reviewed, not to every bug in the app.
- The judge is a model, so regrading the same reports can change a few matches.
- QA-Bench was built and is maintained by Momentic, which also builds Mo, one
  of the evaluated agents.

## License

The labels, briefs, and seed scripts are released under the MIT license. The
dataset contains no upstream source or binaries; `compose.yaml` pulls each
app's official image by digest. The apps keep their own licenses: Gitea is MIT,
Saleor is BSD-3-Clause, and Metabase and Twenty are AGPL-3.0 with commercially
licensed enterprise code.

## Citation

```bibtex
@misc{qabench2026,
  title        = {QA-Bench: Evaluating Autonomous QA Agents on Real Web Applications},
  author       = {Momentic},
  year         = {2026},
  howpublished = {\url{https://huggingface.co/datasets/momentic/qa-bench}}
}
```
