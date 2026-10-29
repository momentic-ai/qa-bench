#!/bin/sh
set -eu
url="http://localhost:$FIXTURE_PORT/api"
credentials=$(jq -n --arg username "$FIXTURE_USERNAME" --arg password "$FIXTURE_PASSWORD" '{username:$username,password:$password}')
session=$(curl --fail --silent --show-error --max-time 30 -H 'Content-Type: application/json' --data "$credentials" "$url/session" | jq -er .id)
api() {
  curl --fail --silent --show-error --max-time 30 -H "X-Metabase-Session: $session" "$url/$1"
}
api database | jq -e '(if type == "array" then . else .data end) | all(.is_sample == true)' > /dev/null
api user | jq -e '(if type == "array" then . else .data end) | length == 1' > /dev/null
curl --fail --silent --show-error --max-time 30 -X DELETE -H "X-Metabase-Session: $session" "$url/session" > /dev/null
printf 'Empty Metabase verified: one account, only built-in sample databases.\n'
