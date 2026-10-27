#!/bin/sh
set -eu

[ -f /data/gitea/fixture-seeded ]
[ ! -f /data/gitea/fixture-seeding ]
api() {
  curl --fail --silent --show-error --max-time 30 \
    --user "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" \
    "http://localhost:$FIXTURE_PORT/api/v1$1"
}
api /user > /dev/null
api "/repos/$FIXTURE_USERNAME/harbor-handbook" > /dev/null
api "/repos/$FIXTURE_USERNAME/harbor-handbook/issues/4/comments" | grep -q 'captain rotation'
