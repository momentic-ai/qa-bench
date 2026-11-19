# Metabase (eval-fixture-metabase) test environment

This repo is a Metabase fork: a Clojure backend (`src/`, `enterprise/backend`) and a React/TypeScript frontend (`frontend/src`). Each PR targets its own `codex/pr-<n>/base` branch, and the bases span four eras:

| Bases                                   | JDK | Node | JS package manager | Frontend build              |
| --------------------------------------- | --- | ---- | ------------------ | --------------------------- |
| pr-22903 (2022)                         | 11  | 16   | Yarn 1             | webpack (`yarn build`)      |
| pr-47581, 51229, 51345 (2024)           | 11  | 18   | Yarn 1             | rspack (`build-release`)    |
| pr-60725 to pr-68539 (2025–Jan 2026)    | 21  | 22   | Yarn 1             | rspack (`build-release`)    |
| pr-68095 to pr-81014 (2026)             | 21 or 25 | 22 | bun            | rspack (`build-release`)    |

Never assume one era's commands work on another. The helper below picks the right toolchain from the checkout.

## Toolchains and helper

Temurin JDK 11, 21 and 25, Node 16, 18 and 22, the Clojure CLI, Yarn 1 and each base's bun version are installed under `/opt/trex`. Postgres comes from Debian. Run everything from the root of the PR checkout.

- `metabase-trex <cmd>` (at `/opt/trex/bin/metabase-trex`) does the work. Run `metabase-trex env` first to confirm which JDK, Node and package manager it picked.
- To use `java`, `clojure`, `node`, `yarn` or `bun` directly, run `. /opt/trex/activate` from the checkout root first. Don't use any system Java or Node.
- Each PR checkout needs its own frontend build. Run `metabase-trex build` again after switching branches.

## Supported interfaces and services

- **Metabase web UI and REST API** (`/api`) on http://localhost:3000. The backend runs from source in production run mode (`-Dmb.run.mode=prod`), the eval's run mode, with the release frontend bundle and static-viz bundle in `resources/frontend_client`. The first start compiles the backend, which takes 3 to 6 minutes.
- **H2 application database** at `/tmp/metabase-trex/metabase.db`, as in the eval, with Metabase's built-in **Sample Database**.
- **Postgres** on 127.0.0.1:5432 (user `postgres`, trust auth), started as in the eval. Use it to add a Postgres data source with your own tables.
- **Backend tests (`clojure -X:dev:test`) and frontend unit tests (Jest).**

Excluded:

- **The production uberjar and its bundled driver plugins** (BigQuery, Snowflake, Redshift, Athena, Mongo and others). They need cloud services. H2, Postgres and MySQL drivers are built in.
- **Email, Slack, SSO/LDAP, and Enterprise features** (the eval runs the OSS edition).
- **Cypress e2e tests.** No browser binaries are installed for them. Test the UI against the running server instead.

## Build and run

| Step          | Command                                                   | Notes                                                                                                                                                            |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build         | `metabase-trex build`                                     | Installs JS deps, downloads backend deps, then builds the release frontend (ClojureScript and rspack/webpack) and the static-viz bundle. A cold build takes 15 to 25 minutes. JS and Maven caches for every base branch are warm. |
| Frontend only | `metabase-trex frontend`                                  | Then reload the page. No restart needed.                                                                                                                         |
| Backend       | `metabase-trex stop && metabase-trex start`               | The backend runs from source, so a restart picks up `src/` changes.                                                                                             |
| Start         | `metabase-trex start`                                     | Starts Postgres and Metabase with the eval's settings in the background.                                                                                        |
| Ready         | `metabase-trex status` or `curl -fsS http://localhost:3000/api/health` | Returns `{"status":"ok"}` when ready.                                                                                                              |
| Logs          | `/tmp/metabase-trex/metabase.log`, `/tmp/metabase-trex/postgres.log` |                                                                                                                                                  |
| Stop          | `metabase-trex stop`                                      |                                                                                                                                                                  |

## Seed data and sign-in

The environment uses the eval's own Metabase recipe from qa-bench (`fixtures/web/oss/metabase`): its settings (H2 app database, tracking and update checks off), its seed (Metabase setup with one admin account), its verification and its account. `metabase-trex env` prints the account; below, `<user>` and `<password>` mean those values. Sign in at http://localhost:3000.

`metabase-trex reset` wipes `/tmp/metabase-trex`, starts fresh, reseeds, and runs the eval's check for its starting state: one account and only the built-in Sample Database. Use it between scenarios, and always after switching to a different base, because migrations only move forward.

Create the data each scenario needs through the UI or the API. Get a session with `curl -s -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<password>"}' http://localhost:3000/api/session | jq -r .id` and send `X-Metabase-Session: <id>`. Create questions (`POST /api/card`), dashboards (`POST /api/dashboard`, then `PUT /api/dashboard/{id}` with `dashcards`), collections (`POST /api/collection`), users (`POST /api/user`) and data sources (`POST /api/database`). For your own Postgres tables, `createdb -h 127.0.0.1 -U postgres mydb`, load data with `psql`, then add the database with host `127.0.0.1`, port 5432, user `postgres` and an empty password.

## Tests

- Backend, focused: `metabase-trex test-backend :only metabase.some.namespace-test` (or `:only metabase.some.namespace-test/some-test`). It uses H2 and needs no running server; the first run compiles for several minutes.
- Frontend: `metabase-trex test-frontend <path or pattern>` runs the checkout's `test-unit` script (Jest), e.g. `metabase-trex test-frontend frontend/src/metabase/visualizations`. Name specific files; the full suite is very slow.
- Types and lint (optional), after activating: `yarn type-check` or `bun run type-check`, and `lint-eslint`.

## End-to-end testing approach

Starting state: run `metabase-trex build && metabase-trex reset`, then sign in as `<user>`. Build the state the change needs through the UI or the API.

What to observe for each area:

- **Query builder and questions** (`frontend/src/metabase/query_builder`, `querying`, `lib`): build questions on the Sample Database with filters, summaries, breakouts, joins and custom columns; switch between notebook, editor and SQL views; save, reload and check the results and the URL.
- **Visualizations and charts** (`frontend/src/metabase/visualizations`, `static-viz`): pick the chart types and settings in question (axes, series, formatting, goal lines) and check the rendered chart, its tooltips and its settings after saving.
- **Dashboards** (`frontend/src/metabase/dashboard`): add questions, text cards and filters, wire filters to cards, resize and rearrange, save, and check the dashboard after reload and in fullscreen.
- **Data model and admin** (`admin`, `data-modeling`): edit table and field metadata, semantic types and visibility in the admin data model, and manage users, groups and permissions.
- **Backend APIs and query processing** (`src/metabase`): call the matching `/api` routes and check status codes and JSON, plus `metabase-trex test-backend` on the namespace.
- **Permissions**: create a non-admin user (`POST /api/user`), restrict a collection or data access, and repeat the flow as that user.

Every PR checkout also gets `metabase-trex test-frontend` on touched or related frontend tests and `metabase-trex test-backend` on touched backend namespaces.
