#!/bin/sh
set -eu
export USER=git
export GITEA_CUSTOM=/data/gitea

database_type=$(curl --fail --silent --show-error --max-time 30 "$FIXTURE_URL/" | sed -n 's/.*name="db_type"[^>]*value="\([^"]*\)".*/\1/p')
if [ -z "$database_type" ]; then
  echo 'Gitea installer did not expose a database type.' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 60 \
  --data-urlencode "db_type=$database_type" \
  --data-urlencode charset=utf8 \
  --data-urlencode db_path=/data/gitea/gitea.db \
  --data-urlencode 'app_name=Harbor Engineering' \
  --data-urlencode repo_root_path=/data/git/repositories \
  --data-urlencode lfs_root_path=/data/git/lfs \
  --data-urlencode run_user=git \
  --data-urlencode "domain=$FIXTURE_HOST" \
  --data-urlencode "http_port=$FIXTURE_PORT" \
  --data-urlencode ssh_port=0 \
  --data-urlencode "app_url=$FIXTURE_URL/" \
  --data-urlencode log_root_path=/data/gitea/log \
  --data-urlencode offline_mode=on \
  --data-urlencode disable_gravatar=on \
  --data-urlencode disable_registration=on \
  --data-urlencode require_sign_in_view=on \
  --data-urlencode password_algorithm=pbkdf2 \
  --data-urlencode "admin_name=$FIXTURE_USERNAME" \
  --data-urlencode "admin_passwd=$FIXTURE_PASSWORD" \
  --data-urlencode "admin_confirm_passwd=$FIXTURE_PASSWORD" \
  --data-urlencode admin_email=admin@example.test \
  "$FIXTURE_URL/" > /dev/null
attempt=0
until [ "$(curl --fail --silent --connect-timeout 2 --max-time 5 --user "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" --output /tmp/gitea-user.json --write-out '%{http_code}' http://localhost:3000/api/v1/user)" = 200 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Gitea account was not ready after 30 checks.' >&2
    exit 1
  fi
  sleep 1
done
