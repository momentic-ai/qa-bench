# Grafana (eval-fixture-grafana) test environment

This repo is a Grafana fork: a Go server (`pkg/`) and a React/TypeScript frontend (`public/app`, `packages/`). Each PR targets its own `codex/pr-<n>/base` branch, and the bases span three eras:

| Era                                     | go.mod     | Node (`.nvmrc`) | Yarn (committed `yarnPath`)           | Server binary                 |
| --------------------------------------- | ---------- | --------------- | ------------------------------------- | ----------------------------- |
| 2021–22 (pr-40010, 45804, 52167, 55563) | 1.17–1.18  | 16              | 3.x (`node-modules` or PnP)           | `bin/linux-amd64/grafana-server` |
| 2025 (pr-111645)                        | 1.24       | 22              | 4.9                                   | `bin/linux-amd64/grafana server` |
| 2026 (pr-122693 and later)              | 1.26–1.27  | 24              | 4.11–4.18                             | `bin/linux-amd64/grafana server` |

Never assume one era's commands work on another. The helper below picks the right toolchain from the checkout.

## Toolchains and helper

Go 1.17.13, 1.19.13, 1.24.6, 1.26.6 and 1.27.3 and Node 16, 22 and 24 are installed under `/opt/trex`. A `yarn` shim runs the Yarn release each checkout commits, so no Yarn download is needed. Run everything from the root of the PR checkout.

- `grafana-trex <cmd>` (at `/opt/trex/bin/grafana-trex`) does the work. Run `grafana-trex env` first to confirm which Go, Node and Yarn it picked.
- To use `go`, `node` or `yarn` directly, run `. /opt/trex/activate` from the checkout root first. Don't use any system Go or Node.
- Each PR checkout needs its own build. Run `grafana-trex build` again after switching branches.

## Supported interfaces and services

- **Grafana web UI and HTTP API** (`/api`), served by one Grafana server process on http://localhost:3000 in production mode, as in the eval.
- **SQLite** is the only database. It lives in `/tmp/grafana-trex/data/grafana.db`.
- **Go unit tests and frontend unit tests (Jest).**

Excluded:

- **External data sources** (Prometheus, Loki, Elasticsearch, cloud services). None run here, and the eval starts with none. Use the built-in **TestData** data source (`type: testdata`, called TestData DB on older bases), which generates series, tables, logs and errors locally.
- **MySQL and PostgreSQL backends, and Go integration tests that need them.**
- **Mail, Slack and other notification channels, OAuth/LDAP, plugin downloads from grafana.com, and the update checker.** They need external services.
- **Grafana's Cypress and Playwright e2e suites.** No browser binaries are installed for them. Test the UI against the running server instead.

## Build and run

| Step          | Command                                                       | Notes                                                                                                                                                          |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build         | `grafana-trex build`                                          | `yarn install --immutable`, `make build-go` (Wire codegen and the server binary under `bin/`), then `yarn build` (production webpack bundle into `public/build`). A cold build takes 20 to 30 minutes, mostly the frontend bundle. Go and Yarn caches for every base branch are warm. |
| Backend only  | `grafana-trex backend`                                        | Use after Go-only changes, then restart.                                                                                                                       |
| Frontend only | `grafana-trex frontend`                                       | Use after `public/` or `packages/` changes, then reload the page. No restart needed.                                                                          |
| Start         | `grafana-trex start`                                          | Applies the eval's settings and starts the server in the background with `--homepath` at the checkout.                                                         |
| Ready         | `grafana-trex status` or `curl -fsS http://localhost:3000/api/health` |                                                                                                                                                       |
| Logs          | `/tmp/grafana-trex/stdout.log`, `/tmp/grafana-trex/log/grafana.log` |                                                                                                                                                          |
| Stop          | `grafana-trex stop`                                           |                                                                                                                                                                |

## Seed data and sign-in

The environment uses the eval's own Grafana recipe: its settings (light theme, analytics and news off, the admin account), and its check for the starting state. `grafana-trex env` prints the account; below, `<user>` and `<password>` mean those values. Grafana creates that admin account on first start. Sign in at http://localhost:3000/login.

`grafana-trex reset` wipes `/tmp/grafana-trex`, starts fresh, and runs the eval's check: one account, and no dashboards or data sources. Use it between scenarios, and always after switching to a different base era, because an older binary can't open a newer database.

Create the data each scenario needs through the UI or the API with basic auth (`curl -u <user>:<password> -H 'Content-Type: application/json' http://localhost:3000/api/...`): data sources (`POST /api/datasources`, e.g. `{"name":"TestData","type":"testdata","access":"proxy"}`), dashboards (`POST /api/dashboards/db` with a dashboard JSON and `"overwrite": true`), folders (`POST /api/folders`), users (`POST /api/admin/users`, then `PATCH /api/org/users/{id}` with a role), teams, preferences (`PUT /api/user/preferences`), alert rules and annotations.

## Tests

- Go, focused: `grafana-trex test-backend ./pkg/services/folder/...`. It runs `go test -short` with the checkout's Go. Tests that need MySQL or Postgres skip or fail; use SQLite ones.
- Frontend: `grafana-trex test-frontend [paths or patterns]` runs Jest, e.g. `grafana-trex test-frontend public/app/features/dashboard`. Name specific files; the full suite is very slow.
- Types and lint (optional), after activating: `yarn typecheck`, `yarn lint`. Both are slow on this codebase.

## End-to-end testing approach

Starting state: run `grafana-trex build && grafana-trex reset`, then sign in as `<user>`. Build the state the change needs through the UI or the API.

What to observe for each area:

- **Dashboards, panels and visualizations** (`public/app/features/dashboard*`, `public/app/plugins/panel`, `packages/grafana-ui`, `packages/grafana-data`): add a TestData data source, create a dashboard with the panel types and options in question, then edit, save, reload and check what persisted. Try panel edit, field overrides, value mappings, units, legends and tooltips, and watch the browser console.
- **Data sources and query editors** (`public/app/plugins/datasource`, `pkg/services/datasources`, `pkg/tsdb`): create data sources through the UI and API, save and test them, and check what the API returns for their settings (secure fields show only as set or unset).
- **Preferences, users, teams and folders** (`pkg/services/preference`, `pkg/services/folder`, `pkg/api`): change user, team and org preferences (theme, timezone, home dashboard), create nested folders and permissions, and check both the UI and the API responses.
- **Explore and query history** (`public/app/features/explore`): open Explore with TestData, run queries, and check results, history and split views.
- **Alerting**: create alert rules against TestData in the Alerting UI and check the rule list and its state. No notifications are delivered.
- **Styles** (`public/sass`, theme files): check the affected pages in both light (the eval's default) and dark theme.
- **Permissions**: create Viewer and Editor users and repeat the flow as each.

Every PR checkout also gets `grafana-trex test-backend` on the touched Go packages and `grafana-trex test-frontend` on touched or related frontend tests.
