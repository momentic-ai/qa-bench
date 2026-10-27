#!/bin/sh
set -eu

export USER=git
export GITEA_CUSTOM=/data/gitea
export GITEA__DEFAULT__APP_NAME='Harbor Engineering'
export GITEA__database__DB_TYPE=sqlite3
export GITEA__database__PATH=/data/gitea/gitea.db
export GITEA__server__ROOT_URL="$FIXTURE_URL/"
export GITEA__server__DOMAIN="$FIXTURE_HOST"
export GITEA__server__HTTP_PORT="$FIXTURE_PORT"
export GITEA__server__DISABLE_SSH=true
export GITEA__service__DISABLE_REGISTRATION=true
export GITEA__service__REQUIRE_SIGNIN_VIEW=true
export GITEA__service__ENABLE_NOTIFY_MAIL=false
export GITEA__mailer__ENABLED=false
export GITEA__picture__DISABLE_GRAVATAR=true
export GITEA__openid__ENABLE_OPENID_SIGNIN=false
export GITEA__openid__ENABLE_OPENID_SIGNUP=false
export GITEA__actions__ENABLED=${GITEA__actions__ENABLED:-false}
if [ "$FIXTURE_CASE" != gitea-pr-16829 ]; then
  # The oldest revision needs its HTTP installer; later images support automatic installation.
  export GITEA__security__INSTALL_LOCK=true
fi
if [ -x /usr/bin/s6-svscan ]; then
  # Older upstream images install s6 under /usr/bin.
  s6=/usr/bin/s6-svscan
else
  # Newer upstream images install s6 under /bin.
  s6=/bin/s6-svscan
fi
exec /usr/bin/entrypoint "$s6" /etc/s6
