# Gitea (eval-fixture-gitea) test environment

This repo is a Gitea fork. Each PR targets its own `codex/pr-<n>/base` branch, and the bases span four Gitea eras:

| Era                       | go.mod             | Frontend               | SQLite build tags             |
| ------------------------- | ------------------ | ---------------------- | ----------------------------- |
| 2021 (pr-16829)           | go 1.16, `vendor/` | npm + webpack, Jest    | `sqlite sqlite_unlock_notify` |
| 2024 (pr-30273, pr-32646) | go 1.22 / 1.23     | npm + webpack, Vitest  | `sqlite sqlite_unlock_notify` |
| 2026 (pr-36784)           | go 1.26            | pnpm 10 + vite, Vitest | `sqlite sqlite_unlock_notify` |
| 2026 (pr-37571, pr-38706) | go 1.26            | pnpm 11 + vite, Vitest | none (pure-Go SQLite)         |

Never assume one era's commands work on another. The helper below picks the right toolchain from the checkout.

## Toolchains and helper

Go 1.16.15, 1.22.12, 1.23.12 and 1.26.5, Node 16, 20 and 22, and git 2.56 are installed under `/opt/trex`. The 2026 bases get git 2.56 because their tests use `git config set`; older bases use the system git. Run everything from the root of the PR checkout.

- `gitea-trex <cmd>` (at `/opt/trex/bin/gitea-trex`) does the work. Run `gitea-trex env` first to confirm which Go, Node and pnpm it picked.
- To use `go`, `node`, `npm`, `npx` or `pnpm` directly, run `. /opt/trex/activate` from the checkout root first. It sets `PATH` and `GITEA_TAGS` for that checkout. Don't use any system Go or Node.
- Each PR checkout needs its own build. Run `gitea-trex build` again after switching branches.

## Supported interfaces and services

- **Gitea web UI and REST API** (`/api/v1`), served by one `gitea web` process on http://localhost:3000.
- **SQLite** is the only database. It lives in a disposable file at `/tmp/gitea-trex/gitea/gitea.db`.
- **Git over HTTP**, e.g. `git clone http://<user>:<password>@localhost:3000/<user>/<repo>.git`.
- **Go unit and integration tests, and frontend unit tests.**

Excluded:

- **MySQL, PostgreSQL and MSSQL test variants.** They need external database servers. SQLite covers the same code paths.
- **SSH.** It's disabled so it can't clash with the VM's port 22. Use HTTP git instead.
- **Mail, OAuth providers, Gravatar and the update checker.** These are external services, so they're turned off (`OFFLINE_MODE`).
- **Actions runners.** No `act_runner` is installed, so workflow jobs stay queued.
- **Gitea's own Playwright e2e suite** (`make test-e2e*`). It needs a browser download that matches each era. Test the UI against the running server instead.

## Build and run

| Step          | Command                                                                       | Notes                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build         | `gitea-trex build`                                                            | Runs `make build TAGS=$GITEA_TAGS`: frontend deps, frontend bundle, and the `./gitea` binary at the checkout root. A cold build takes about 5 to 10 minutes. Caches for every base branch are warm. |
| Backend only  | `gitea-trex backend`                                                          | Use after Go or template-only changes. Templates are read from disk, so a restart is enough.                                                                                                        |
| Frontend only | `gitea-trex frontend`                                                         | Use after `web_src/` changes, then reload the page. No restart needed.                                                                                                                              |
| Start         | `gitea-trex start`                                                            | Writes `/tmp/gitea-trex/gitea/conf/app.ini`, applies the eval's settings, and starts `./gitea web` in the background.                                                                               |
| Ready         | `gitea-trex status` or `curl -fsS http://localhost:3000/user/login`           | Wait for HTTP 200. Older bases have no `/api/healthz`.                                                                                                                                              |
| Logs          | `/tmp/gitea-trex/gitea/log/stdout.log`, `/tmp/gitea-trex/gitea/log/gitea.log` |                                                                                                                                                                                                     |
| Stop          | `gitea-trex stop`                                                             |                                                                                                                                                                                                     |

## Seed data and sign-in

The environment uses the eval's own Gitea recipe from qa-bench (`fixtures/web/oss/gitea`): its settings, its install and seed script, its verification and its account. `gitea-trex env` prints the account; below, `<user>` and `<password>` mean those values. `gitea-trex seed` starts the server if needed and installs Gitea with that admin account. It doesn't remove data you add. Sign in at http://localhost:3000/user/login. Registration is disabled and every page requires sign-in, as in the eval.

`gitea-trex reset` wipes `/tmp/gitea-trex`, starts fresh, reseeds, and runs the eval's check for its starting state: that one admin and no repos or other data. Use it between scenarios, and always after switching to a different base era, because an older binary can't open a newer database.

Create the data each scenario needs, through the UI or the API with basic auth: `curl -H 'Content-Type: application/json' http://<user>:<password>@localhost:3000/api/v1/...`. Create repos (`POST /user/repos`), branches, files (`POST /repos/{owner}/{repo}/contents/{path}`), issues, labels, pull requests (`POST /repos/{owner}/{repo}/pulls`) and extra users (`POST /admin/users`). You can also clone a repo over HTTP, commit, and push branches to build diffs or PRs. For wiki tests, create the first page in the UI, or with `POST /repos/{owner}/{repo}/wiki/new` on 2024+ bases (2021 has no wiki API). Then push to `<repo>.wiki.git` if you need specific files.

## Tests

- Go, focused: `gitea-trex test-backend ./services/gitdiff/... ./modules/markup/...`. This adds the right tags and uses `-mod=vendor` automatically on the 2021 base. Model and service tests load YAML fixtures from `models/fixtures` into a temporary SQLite database. They don't need the running server.
- Go integration (SQLite): `. /opt/trex/activate && make test-sqlite#TestName`. On 2024+ bases the tests are in `tests/integration`; on 2021 they're in `integrations/`. These build a separate test binary and use fixture repos from `tests/gitea-repositories-meta` (or `integrations/gitea-repositories-meta`). They're slow, so pick specific tests.
- Frontend: `gitea-trex test-frontend [files]` runs Jest on the 2021 base and Vitest on later ones.
- Lint (optional): `make lint-js`, `make lint-css` or `make lint-go` after activating. These may download linters through the Go module proxy.

## End-to-end testing approach

Starting state: run `gitea-trex build && gitea-trex reset`, then sign in as `<user>`. Build the state the change needs through the UI, the API or git pushes, not through fixtures.

What to observe for each area:

- **Diff and compare views** (`services/gitdiff`, `templates/repo/diff`, `web_src/js/features/diff*`): push a branch with many or large files, then open `/{owner}/{repo}/compare/main...branch` and the PR "Files changed" tab. Check the file list, load-more and expand behavior, the rendered hunks, highlighting, and escape warnings. Compare with the same page on the base build when it helps.
- **Markup, markdown and wiki** (`modules/markup`): create issues, comments, README files, or wiki pages (push to `<repo>.wiki.git` or use the wiki UI) with the links and long names in question. Check the rendered HTML and link targets.
- **Templates, JS and modals** (`templates/`, `web_src/js`): use the affected pages directly. The admin pages are under `/-/admin` from pr-32646 on, and under `/admin` on older bases. Watch the browser console for errors.
- **API changes**: call `/api/v1/...` with basic auth and check status codes and JSON. The Swagger UI is at `/api/swagger`.
- **Actions**: off by default, as in the eval. If the change touches Actions, run `export GITEA__actions__ENABLED=true` before `gitea-trex reset`; each start reapplies the setting.
- **Devtest pages** (`templates/devtest`, `routers/web/devtest`): Gitea runs in prod mode, as in the eval, so `/devtest` returns 404. Test the changed components on the real pages that use them, such as `/-/admin/emails` or the issue list.
- **Permissions**: create a non-admin user with `POST /admin/users` (`must_change_password: false`) and repeat the flow as that user. Signed-out visitors are sent to the sign-in page.

Every PR checkout also gets `gitea-trex test-backend` on the touched packages and `gitea-trex test-frontend` when `web_src/` changes.
