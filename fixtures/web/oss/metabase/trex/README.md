# Greptile TREX environment

TREX configuration for `momentic-ai/eval-fixture-metabase`, the repository Greptile
reviews in the PR evals. Greptile builds it in its own VM, and it needs no
environment variables. The build fetches this Metabase recipe from qa-bench, and
TREX uses the same settings and start scripts (`runtime/snapshot/`), seed (`snapshot/seed.mjs`), check (`snapshot/verify.sh`) and account (`fixture.json`) as the eval snapshots.
It rewrites the snapshot image's paths to its own and runs Postgres as the VM
user instead of through `su-exec`.

Run these from a checkout of the fixture repository, with the Greptile CLI
signed in as a repository admin and `CONFIG` set to this directory. The first
command pins the recipe to this checkout's commit, which must be on GitHub:

```bash
sed "s/^QA_BENCH_REF=.*/QA_BENCH_REF=$(git -C "$CONFIG" rev-parse HEAD)/" "$CONFIG/setup.sh" | greptile environment setup-script set
greptile environment setup-instructions set < "$CONFIG/instructions.md"
greptile environment network-policy set build custom --domain '*.githubusercontent.com' --domain api.adoptium.net --domain build.shibboleth.net --domain deb.debian.org --domain download.clojure.org --domain files.pythonhosted.org --domain github.com --domain nodejs.org --domain pypi.org --domain repo.clojars.org --domain repo1.maven.org --domain s3.amazonaws.com --domain security.debian.org
greptile environment network-policy set review custom --domain build.shibboleth.net --domain repo.clojars.org --domain repo1.maven.org --domain s3.amazonaws.com
greptile environment build --follow
```

Custom network policies always allow `registry.npmjs.org`, which the build uses
for JS packages. The build takes over an hour. It installs the JDK and Node versions the PR bases need, the Clojure CLI and Postgres, builds this checkout's frontend, and warms JS and Maven caches for each `codex/pr-*/base` branch.
