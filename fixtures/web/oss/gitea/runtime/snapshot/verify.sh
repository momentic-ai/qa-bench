#!/bin/sh
set -eu
api() {
  curl --fail --silent --show-error --max-time 30 \
    --user "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" \
    "http://localhost:$FIXTURE_PORT/api/v1/$1"
}
api user | jq -e --arg login "$FIXTURE_USERNAME" '.login == $login' > /dev/null
api user/repos | jq -e 'length == 0' > /dev/null
api admin/users | jq -e 'length == 1' > /dev/null
printf 'Empty Gitea verified: one account, no repositories.\n'
