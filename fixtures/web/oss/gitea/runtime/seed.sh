#!/bin/sh
set -eu

base_url=${FIXTURE_URL:-http://gitea:3000}
username=${FIXTURE_USERNAME:-eval}
password=${FIXTURE_PASSWORD:-momentic-eval-1}
export FIXTURE_USERNAME="$username" FIXTURE_PASSWORD="$password"
git_credentials='!f() { printf "%s\n" "username=$FIXTURE_USERNAME" "password=$FIXTURE_PASSWORD"; }; f'
credentials="$username:$password"
seed_marker=/data/gitea/fixture-seeded

api() {
  method=$1
  endpoint=$2
  shift 2
  if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    --user "$credentials" --header 'Content-Type: application/json' \
    --request "$method" "$base_url/api/v1$endpoint" "$@"; then
    echo "Gitea API request failed: $method $endpoint" >&2
    return 1
  fi
}

if [ ! -f "$seed_marker" ]; then
  if ! api GET /user > /dev/null; then
    gitea --config /data/gitea/conf/app.ini admin user create \
      --username "$username" --password "$password" --email admin@example.test \
      --admin --must-change-password=false
  fi

  # Refuse to silently accept a partially seeded database after a failed bootstrap.
  if [ -f /data/gitea/fixture-seeding ]; then
    echo 'Incomplete seed. Run docker compose down -v, then launch the fixture again.' >&2
    exit 1
  fi
  touch /data/gitea/fixture-seeding

  api POST /admin/users --data '{"username":"alex","email":"alex@example.test","password":"momentic-contributor-1","full_name":"Alex Rivera","must_change_password":false}' > /dev/null
  api POST /admin/users --data '{"username":"maya","email":"maya@example.test","password":"momentic-eval-1","full_name":"Maya Chen","must_change_password":false}' > /dev/null
  api POST /user/repos --data '{"name":"harbor-handbook","description":"Engineering handbook and release planning for the Harbor team.","private":false,"default_branch":"main","auto_init":false}' > /dev/null
  repo="/repos/$username/harbor-handbook"
  api PUT "$repo/collaborators/alex" --data '{"permission":"write"}' > /dev/null
  api PUT "$repo/collaborators/maya" --data '{"permission":"write"}' > /dev/null

  work_dir=$(mktemp -d)
  cd "$work_dir"
  git init -b main
  git config user.name 'Harbor Admin'
  git config user.email admin@example.test
  export GIT_AUTHOR_DATE=2025-09-01T09:00:00Z
  export GIT_COMMITTER_DATE=2025-09-01T09:00:00Z
  cat > README.md <<'EOF'
# Harbor engineering handbook

Welcome to Harbor, a small team building a shared project workspace.

- [Contributor guide](docs/contributing.md)
- [Release checklist](docs/releases.md)

Use issues to plan work, milestones to track releases, and pull requests to review handbook changes.
The next release focuses on onboarding and making ownership clear.
EOF
  mkdir docs
  cat > docs/contributing.md <<'EOF'
# Contributing

1. Open an issue describing the proposed change.
2. Create a branch and keep the change focused.
3. Link the issue in a pull request and ask a teammate to review.
4. Merge after review and update the release notes.
EOF
  cat > docs/releases.md <<'EOF'
# Release checklist

- [ ] Review open issues against the milestone.
- [ ] Confirm the documentation matches the release.
- [ ] Tag the approved commit.
- [ ] Publish release notes.
EOF
  git add .
  git commit -m 'Add engineering handbook and release checklist'
  git remote add origin "$base_url/$username/harbor-handbook.git"
  git -c credential.helper="$git_credentials" push origin main
  git tag v1.0.0
  git -c credential.helper="$git_credentials" push origin v1.0.0
  git checkout -b docs/release-owners
  cat >> docs/releases.md <<'EOF'

## Release ownership

The release captain coordinates the checklist. A second maintainer verifies the tag
and release notes before publication. Rotate the captain each release.
EOF
  git config user.name 'Alex Rivera'
  git config user.email alex@example.test
  export GIT_AUTHOR_DATE=2025-09-02T10:00:00Z
  export GIT_COMMITTER_DATE=2025-09-02T10:00:00Z
  git add docs/releases.md
  git commit -m 'Document release captain and verification responsibilities'
  git -c credential.helper="$git_credentials" push origin docs/release-owners
  cd /tmp
  rm -rf "$work_dir"

  api POST "$repo/labels" --data '{"name":"documentation","color":"0075ca","description":"Handbook and onboarding improvements"}' > /dev/null
  api POST "$repo/labels" --data '{"name":"enhancement","color":"a2eeef","description":"New workflows and capabilities"}' > /dev/null
  api POST "$repo/milestones" --data '{"title":"Handbook 1.1","description":"Onboarding and release ownership improvements","state":"open"}' > /dev/null
  api POST "$repo/issues" --data '{"title":"Expand the onboarding checklist","body":"Add a first-week checklist covering repository access, team introductions, and a starter documentation change.","assignees":["alex"]}' > /dev/null
  api POST "$repo/issues" --data "{\"title\":\"Clarify release ownership\",\"body\":\"Document who coordinates a release and who verifies the published tag. Include a rotation policy.\",\"assignees\":[\"$username\"]}" > /dev/null
  api POST "$repo/issues" --data '{"title":"Publish the initial contributor guide","body":"Capture the issue, branch, review, and merge workflow in the handbook.","closed":true}' > /dev/null
  api POST "$repo/issues" --data '{"title":"Review the release ownership proposal","body":"Review the changes on the docs/release-owners branch and confirm the captain rotation with the team.","assignees":["alex"]}' > /dev/null
  credentials=alex:momentic-contributor-1
  api POST "$repo/issues/1/comments" --data '{"body":"I will draft the first-week checklist and link the access request instructions."}' > /dev/null
  credentials="$username:$password"
  api POST "$repo/issues/4/comments" --data '{"body":"Thanks, Alex. Please confirm the captain rotation with the team before merging."}' > /dev/null

  touch "$seed_marker"
  rm /data/gitea/fixture-seeding
  echo 'Gitea seed complete: handbook and issues.'
fi

api GET /user > /dev/null
api GET /repos/$username/harbor-handbook > /dev/null
touch /tmp/setup-complete
if [ "${1:-}" != "--once" ]; then
  # Compose keeps the setup container alive for its healthcheck.
  exec sleep infinity
fi
