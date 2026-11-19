# Gitea settings shared by the snapshot image and Greptile's TREX environment.
# Set GITEA_DATA to move the data root.
data=${GITEA_DATA:-/data}
export GITEA__DEFAULT__APP_NAME='Harbor Engineering'
export GITEA__database__DB_TYPE=sqlite3
export GITEA__database__PATH="$data/gitea/gitea.db"
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
