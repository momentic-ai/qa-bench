# Twenty (eval-fixture-twenty) test environment

This repo is a Twenty CRM fork: an Nx/Yarn monorepo with a NestJS server (`packages/twenty-server`), a React frontend (`packages/twenty-front`) and shared packages (`twenty-ui`, `twenty-shared`). Each PR targets its own `codex/pr-<n>/base` branch, and the bases span three eras:

| Bases                          | Node (`.nvmrc`) | Yarn (committed) | Server entry          |
| ------------------------------ | --------------- | ---------------- | --------------------- |
| pr-11983 (May 2025)            | 18              | 4.4              | `dist/src/main`       |
| pr-16244 to pr-28291 (2025–26) | 24              | 4.9–4.13         | `dist/main` (most)    |
| pr-29167 (Oct 2026)            | 26              | 4.18             | `dist/main`           |

## Toolchains and helper

Node 18, 24 and 26 are installed under `/opt/trex`; a `yarn` shim runs the Yarn release each checkout commits. Postgres and Redis come from Debian. Run everything from the root of the PR checkout.

- `twenty-trex <cmd>` (at `/opt/trex/bin/twenty-trex`) does the work. Run `twenty-trex env` first to confirm which Node and Yarn it picked.
- To use `node`, `yarn` or `npx nx` directly, run `. /opt/trex/activate` from the checkout root first. Don't use any system Node.
- Each PR checkout needs its own build. Run `twenty-trex build` again after switching branches.

## Supported interfaces and services

- **Twenty web app, GraphQL (`/graphql`, `/metadata`) and REST (`/rest`) APIs**, served by the production server build on http://localhost:3000, which also serves the built frontend, as in the eval.
- **Background worker** (`yarn worker:prod`) for queued jobs, started next to the server.
- **Postgres** on 127.0.0.1:5432 (user `postgres`, trust auth, database `default`) and **Redis** on 127.0.0.1:6379. Both live in `/tmp/twenty-trex` and are disposable.
- **Server and frontend unit tests (Jest).**

Excluded:

- **Email and calendar sync (Google, Microsoft), billing, captcha, Sentry, ClickHouse analytics and serverless functions.** They need external services and aren't configured, as in the eval.
- **The development seed** (`yarn command:prod workspace:seed:dev`). The eval starts from an empty workspace, so the environment does too.
- **Server integration tests** (`*.integration-spec.ts`) and the Playwright e2e suite. They need their own seeded test database or browser binaries. Test the UI against the running server instead.

## Build and run

| Step          | Command                                                              | Notes                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build         | `twenty-trex build`                                                  | `yarn install --immutable`, `npx nx run twenty-server:build`, `npx nx build twenty-front`, then copies the frontend into `packages/twenty-server/dist/front`. A cold build takes 20 to 30 minutes. The build warms the Yarn cache for as many base branches as fit in its time limit. |
| Backend only  | `twenty-trex backend`                                                | Then `twenty-trex stop && twenty-trex start`.                                                                                                                 |
| Frontend only | `twenty-trex frontend`                                               | Then reload the page. No restart needed.                                                                                                                      |
| Start         | `twenty-trex start`                                                  | Starts Postgres, Redis, the server (which runs migrations through its own entrypoint) and the worker in the background.                                       |
| Ready         | `twenty-trex status` or `curl -fsS http://localhost:3000/healthz`    |                                                                                                                                                               |
| Logs          | `/tmp/twenty-trex/server.log`, `/tmp/twenty-trex/worker.log`, `/tmp/twenty-trex/postgres.log` |                                                                                                                       |
| Stop          | `twenty-trex stop`                                                   | Stops the worker, server, Redis and Postgres.                                                                                                                 |

## Seed data and sign-in

The environment uses the eval's own Twenty recipe from qa-bench (`fixtures/web/oss/twenty`): its server settings, its database bootstrap, its seed (one account that signs up, creates and activates a workspace, and finishes onboarding), its verification and its account. `twenty-trex env` prints the account; below, `<user>` and `<password>` mean those values. Sign in at http://localhost:3000.

`twenty-trex reset` wipes `/tmp/twenty-trex`, starts fresh, reseeds, and runs the eval's check for its starting state: one user and one workspace, without the development seed. Use it between scenarios, and always after switching to a different base, because migrations only move forward.

Create the data each scenario needs through the UI or the APIs. Get a token by signing in through the UI and reading `tokenPair` from local storage, or create an API key under Settings → APIs & Webhooks and send `Authorization: Bearer <key>`. REST examples: `POST /rest/companies`, `POST /rest/people`, `POST /rest/opportunities`, `POST /rest/tasks`, `POST /rest/notes`. Custom objects and fields are created under Settings → Data model or through `/metadata` GraphQL.

## Tests

- Server, focused: `twenty-trex test-backend <path or pattern>` runs Jest in `packages/twenty-server`, e.g. `twenty-trex test-backend src/engine/workspace-manager`.
- Frontend, focused: `twenty-trex test-frontend <path or pattern>` runs Jest in `packages/twenty-front`. Name specific files; the full suite is slow.
- Types and lint (optional), after activating: `npx nx typecheck twenty-front`, `npx nx lint twenty-front` (or `twenty-server`).

## End-to-end testing approach

Starting state: run `twenty-trex build && twenty-trex reset`, then sign in as `<user>`. Build the state the change needs through the UI or the APIs.

What to observe for each area:

- **Record tables, boards and views** (`object-record`, `views`): create companies, people and opportunities with varied fields, then sort, filter, group, reorder columns, edit cells inline, and switch between table and Kanban views. Reload to check what persisted.
- **Record pages and the side panel** (`side-panel`, `object-record/record-show`): open records, edit fields, add notes, tasks, attachments and relations, and check the timeline.
- **Settings and the data model** (`pages/settings`, `settings`, `object-metadata`, `metadata-modules`): create custom objects and fields (select, relation, currency, date), rename and deactivate them, and check the tables and record pages that use them.
- **Workflows**: create a workflow with a manual or record trigger and a few actions, activate it, run it, and check its runs. The worker must be running.
- **Server APIs and workspace setup** (`twenty-server/src/engine`): call the GraphQL and REST endpoints the change touches and check status codes and responses. For workspace creation or upgrade code, run `twenty-trex reset` and watch `server.log`.
- **Translations and locale** (`translations`, `utils/i18n`): switch the language under Settings → Experience and check the affected labels.
- **Permissions**: invite a second member or create a role with limited permissions under Settings → Members and Roles, then repeat the flow as that member.

Every PR checkout also gets `twenty-trex test-backend` or `twenty-trex test-frontend` on the touched or related specs.
