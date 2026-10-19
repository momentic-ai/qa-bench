#!/bin/sh
set -eu

username=momentic-admin
password=momentic-eval
email=admin@momentic.example
base_url=http://forgejo:3000

forgejo migrate
forgejo admin user create \
  --username "$username" \
  --password "$password" \
  --email "$email" \
  --admin
for member in maya jordan; do
  forgejo admin user create \
    --username "$member" --password momentic-eval-1 \
    --email "$member@example.test" --must-change-password=false
done
token=$(forgejo admin user generate-access-token \
  --username "$username" \
  --token-name fixture-bootstrap \
  --scopes all \
  --raw)

attempt=0
until wget --quiet --output-document=/dev/null "$base_url/api/healthz"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Forgejo API did not become available for fixture setup." >&2
    exit 1
  fi
  sleep 2
done

post_api() {
  path=$1
  body=$2
  wget --quiet --output-document=/dev/null \
    --post-data="$body" \
    --header='Content-Type: application/json' \
    --header="Authorization: token $token" \
    "$base_url$path"
}

post_api /api/v1/user/repos '{"name":"field-notes","description":"A sample project for exploring repositories, issues, milestones, and activity.","private":false,"auto_init":true,"default_branch":"main"}'
post_api /api/v1/repos/momentic-admin/field-notes/issues '{"title":"Add a weekly release checklist","body":"## Context\n\nWe want a repeatable release process for the Field Notes service.\n\n## Checklist\n\n- [ ] Review merged pull requests\n- [ ] Update the changelog\n- [ ] Verify the deployment notes\n\nThe release captain should post the final summary before tagging a version."}'
post_api /api/v1/repos/momentic-admin/field-notes/issues '{"title":"Document the import workflow","body":"New contributors need a short guide to importing existing notes.\n\nPlease include supported file types, how duplicate titles are handled, and where validation errors appear."}'
post_api /api/v1/repos/momentic-admin/field-notes/issues '{"title":"Track mobile layout follow-up","body":"The repository overview and issue list should remain easy to scan on narrow screens. Capture any layout changes in a separate pull request."}'

touch /tmp/bootstrap-complete
while :; do
  sleep 3600
done
