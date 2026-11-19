# Greptile TREX environment

TREX configuration for `momentic-ai/eval-fixture-twenty`, the repository Greptile
reviews in the PR evals. Greptile builds it in its own VM, and it needs no
environment variables. The build fetches this Twenty recipe from qa-bench, and
TREX uses the same settings, database bootstrap, start scripts (`runtime/snapshot/`), seed (`snapshot/seed.mjs`), check (`snapshot/verify.sh`) and account (`fixture.json`) as the eval snapshots.
It rewrites the snapshot image's paths to its own and runs Postgres as the VM
user instead of through `su-exec`.

Run these from a checkout of the fixture repository, with the Greptile CLI
signed in as a repository admin and `CONFIG` set to this directory. The first
command pins the recipe to this checkout's commit, which must be on GitHub:

```bash
sed "s/^QA_BENCH_REF=.*/QA_BENCH_REF=$(git -C "$CONFIG" rev-parse HEAD)/" "$CONFIG/setup.sh" | greptile environment setup-script set
greptile environment setup-instructions set < "$CONFIG/instructions.md"
greptile environment network-policy set build custom --domain deb.debian.org --domain github.com --domain nodejs.org --domain security.debian.org
greptile environment network-policy set review custom --domain github.com
greptile environment build --follow
```

Custom network policies always allow `registry.npmjs.org`, which the build uses
for JS packages. The build takes about an hour. It installs the Node versions the PR bases need, Postgres and Redis, builds this checkout, and warms the Yarn cache for each `codex/pr-*/base` branch.
