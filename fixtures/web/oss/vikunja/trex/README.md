# Greptile TREX environment

TREX configuration for `momentic-ai/eval-fixture-vikunja`, the repository Greptile
reviews in the PR evals. Greptile builds it in its own VM, and it needs no
environment variables. The Vikunja recipe is private, so it lives in the Momentic
monorepo (`packages/eval/mo-evals/fixtures/web/oss/vikunja`), not here. The upload
command embeds that recipe's `fixture.json` and `runtime/snapshot/` in the
setup script, so TREX uses the same settings, seed, check and account as the
eval snapshots.

Run these from a checkout of the fixture repository, with the Greptile CLI
signed in as a repository admin, `CONFIG` set to this directory and `MONO`
set to a monorepo checkout:

```bash
recipe=$(tar -C "$MONO/packages/eval/mo-evals/fixtures/web/oss/vikunja" -cz fixture.json runtime/snapshot | base64 -w0)
sed "s|^RECIPE_TGZ_B64=.*|RECIPE_TGZ_B64=$recipe|" "$CONFIG/setup.sh" | greptile environment setup-script set
greptile environment setup-instructions set < "$CONFIG/instructions.md"
greptile environment network-policy set build custom --domain deb.debian.org --domain dl.google.com --domain github.com --domain nodejs.org --domain proxy.golang.org --domain security.debian.org --domain storage.googleapis.com --domain sum.golang.org
greptile environment network-policy set review custom --domain proxy.golang.org --domain storage.googleapis.com --domain sum.golang.org
greptile environment build --follow
```

Custom network policies always allow `registry.npmjs.org`, which the build uses
for JS packages. The build takes about 25 minutes. It installs Go and the Node versions the PR bases need and warms caches for each `codex/pr-*/base` branch.
