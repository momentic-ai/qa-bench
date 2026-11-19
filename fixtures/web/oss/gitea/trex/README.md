# Greptile TREX environment

TREX configuration for `momentic-ai/eval-fixture-gitea`, the repository Greptile
reviews in the PR evals. Greptile builds it in its own VM, and it needs no
environment variables. The build fetches this Gitea recipe from qa-bench, and
TREX uses the same settings (`runtime/snapshot/env.sh`), install and seed
(`snapshot/seed.sh`), check (`snapshot/verify.sh`) and account
(`fixture.json`) as the eval snapshots.

Run these from a checkout of the fixture repository, with the Greptile CLI
signed in as a repository admin and `CONFIG` set to this directory. The first
command pins the recipe to this checkout's commit, which must be on GitHub:

```bash
sed "s/^QA_BENCH_REF=.*/QA_BENCH_REF=$(git -C "$CONFIG" rev-parse HEAD)/" "$CONFIG/setup.sh" | greptile environment setup-script set
greptile environment setup-instructions set < "$CONFIG/instructions.md"
greptile environment network-policy set build custom --domain '*.ubuntu.com' --domain cdn.kernel.org --domain deb.debian.org --domain dl.google.com --domain github.com --domain nodejs.org --domain proxy.golang.org --domain security.debian.org --domain storage.googleapis.com --domain sum.golang.org
greptile environment network-policy set review custom --domain proxy.golang.org --domain storage.googleapis.com --domain sum.golang.org
greptile environment build --follow
```

Custom network policies always allow `registry.npmjs.org`, which the build uses
for pnpm. The build takes about 15 minutes. It installs every Go and Node
version the PR bases need and warms caches for each `codex/pr-*/base` branch.
