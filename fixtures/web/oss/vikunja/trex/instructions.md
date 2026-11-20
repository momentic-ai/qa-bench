# Vikunja (eval-fixture-vikunja) test environment

This repo is a Vikunja fork: a Go API server (`pkg/`) that embeds a Vue 3 frontend (`frontend/`). Each PR targets its own `codex/pr-<n>/base` branch. The bases run from August 2025 to April 2026:

| Bases                                        | Node (`frontend/.nvmrc`) | pnpm      | Go                |
| -------------------------------------------- | ------------------------ | --------- | ----------------- |
| pr-1046, pr-1457, pr-1476, pr-1723 (2025)    | 22                       | 10.14–10.19 | go 1.23–1.24 module |
| pr-1864, pr-1965, pr-2574, pr-2633 (2025–26) | 24                       | 10.22–10.28 | go 1.24–1.25 module |

## Toolchains and helper

Go 1.25.7 (with `GOTOOLCHAIN=local`) and Node 22 and 24 are installed under `/opt/trex`. Run everything from the root of the PR checkout.

- `vikunja-trex <cmd>` (at `/opt/trex/bin/vikunja-trex`) does the work. Run `vikunja-trex env` first to confirm which Node and pnpm it picked.
- To use `go`, `node` or `pnpm` directly, run `. /opt/trex/activate` from the checkout root first. It sets `PATH` and `VIKUNJA_SERVICE_ROOTPATH` for that checkout. Don't use any system Go or Node.
- Each PR checkout needs its own build. Run `vikunja-trex build` again after switching branches.

## Supported interfaces and services

- **Vikunja web UI and REST API** (`/api/v1`), served by one `./vikunja` process on http://localhost:3456. The frontend is built into the binary, as in the eval.
- **SQLite** is the only database. It lives in a disposable file at `/tmp/vikunja-trex/vikunja.db`; uploads go to `/tmp/vikunja-trex/files`.
- **Go tests and frontend unit tests (Vitest).**

Excluded:

- **MySQL and PostgreSQL test variants.** SQLite covers the same code paths.
- **Mail, OpenID, CalDAV clients, Typesense, Redis and third-party migrations (Todoist, Trello, Microsoft To Do).** They need external services and are off, as in the eval.
- **Vikunja's Cypress and Playwright e2e suites.** No browser binaries are installed for them. Test the UI against the running server instead.

## Build and run

| Step          | Command                                                       | Notes                                                                                                                         |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Build         | `vikunja-trex build`                                          | `pnpm install`, `pnpm run build` in `frontend/`, then `go build -o vikunja .`. A cold build takes about 5 minutes. Caches for every base branch are warm. |
| Frontend only | `vikunja-trex frontend` then `vikunja-trex backend`           | The binary embeds `frontend/dist`, so rebuild the binary and restart after frontend changes.                                  |
| Backend only  | `vikunja-trex backend`                                        | Then `vikunja-trex stop && vikunja-trex start`.                                                                               |
| Start         | `vikunja-trex start`                                          | Applies the eval's settings and starts `./vikunja` in the background.                                                          |
| Ready         | `vikunja-trex status` or `curl -fsS http://localhost:3456/api/v1/info` |                                                                                                                       |
| Logs          | `/tmp/vikunja-trex/stdout.log`                                |                                                                                                                               |
| Stop          | `vikunja-trex stop`                                           |                                                                                                                               |

## Seed data and sign-in

The environment uses the eval's own Vikunja recipe: its settings, its seed (one registered account), its verification and its account. `vikunja-trex env` prints the account; below, `<user>` and `<password>` mean those values. `vikunja-trex seed` starts the server if needed and registers that account. It doesn't remove data you add. Sign in at http://localhost:3456/login. Registration stays open, as in the eval.

`vikunja-trex reset` wipes `/tmp/vikunja-trex`, starts fresh, reseeds, and runs the eval's check for its starting state: one account with only its initial project, and no tasks or labels. Use it between scenarios.

Create the data each scenario needs through the UI or the API. Get a token with `curl -s -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<password>"}' http://localhost:3456/api/v1/login | jq -r .token`, then send `Authorization: Bearer <token>`. Vikunja uses `PUT` to create: projects (`PUT /projects`), tasks (`PUT /projects/{id}/tasks`), labels (`PUT /labels`), saved filters (`PUT /filters`), views (`PUT /projects/{id}/views`), and shares and teams. Update with `POST /tasks/{id}`. Register extra users with `POST /register` to test sharing and permissions. The Swagger docs are at `/api/v1/docs`.

## Tests

- Go, focused: `vikunja-trex test-backend ./pkg/models/...`. It runs with `-p 1` and SQLite fixtures from `pkg/db/fixtures`; the activate script sets `VIKUNJA_SERVICE_ROOTPATH` so the tests find them. Web handler tests are in `./pkg/webtests`.
- Frontend: `vikunja-trex test-frontend [files]` runs Vitest in `frontend/`, e.g. `vikunja-trex test-frontend src/helpers/filters.test.ts`.
- Lint and types (optional), after activating, in `frontend/`: `pnpm lint`, `pnpm typecheck`.

## End-to-end testing approach

Starting state: run `vikunja-trex build && vikunja-trex reset`, then sign in as `<user>`. Build the state the change needs through the UI or the API.

What to observe for each area:

- **Filters and the filter input** (`frontend/src/components/input/filter`, `helpers/filters.ts`, `components/project/partials/Filter*`): create labels, projects and tasks with due dates, then type filter queries (`done = false && labels in Alpha`, dates, `project in ...`) in a project's filter popup, in a saved filter, and in a project view's filter. Check highlighting, autocomplete, and that the task list matches the query after saving and reloading.
- **Project views** (List, Gantt, Table, Kanban under `components/project/views`, `components/gantt`): create tasks with start, end and due dates, then open each view. Drag Gantt bars and Kanban cards, and check the dates and buckets saved through the API.
- **Task detail and editor** (`views/tasks`, `components/input/editor`): edit descriptions with the TipTap toolbar, links, mentions (`@user`) and slash commands, add comments and attachments, and reload to check what was saved.
- **Navigation, sidebar and home** (`components/home`, `views/tasks/ShowTasks.vue`): resize and collapse the sidebar, reload, and check the upcoming and overdue task lists on the home page.
- **Backend models** (`pkg/models`): call the matching API routes and check status codes and JSON, plus `vikunja-trex test-backend` on the package.
- **Dependency bumps** (`frontend/package.json`, `pnpm-lock.yaml`): rebuild, then click through the main pages and watch the browser console for errors.
- **Permissions**: register a second user, share a project with read or write access, and repeat the flow as that user.

Every PR checkout also gets `vikunja-trex test-backend` on the touched Go packages and `vikunja-trex test-frontend` on touched or related frontend tests.
