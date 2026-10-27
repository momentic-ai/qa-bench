#!/bin/sh
set -eu
export USER=git
export GITEA_CUSTOM=/data/gitea

if [ "$FIXTURE_CASE" = gitea-pr-16829 ]; then
  # Its admin CLI cannot initialize the first account, so use the normal installer.
  curl --fail --silent --show-error --max-time 60 \
    --data-urlencode db_type=SQLite3 \
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
    http://localhost:3000/ > /dev/null
else
  # These revisions expose an admin command once the app has initialized its database.
  su-exec git gitea --config /data/gitea/conf/app.ini admin user create \
    --username "$FIXTURE_USERNAME" --password "$FIXTURE_PASSWORD" \
    --email admin@example.test --admin --must-change-password=false
fi
attempt=0
until [ "$(curl --fail --silent --connect-timeout 2 --max-time 5 --user "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" --output /tmp/gitea-user.json --write-out '%{http_code}' http://localhost:3000/api/v1/user)" = 200 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    # Installation can restart the server; wait for authentication before seeding.
    echo 'Gitea account was not ready after 30 checks.' >&2
    exit 1
  fi
  sleep 1
done
exec su-exec git sh "${FIXTURE_SEED_SCRIPT:-/fixture/app/seed.sh}" --once
