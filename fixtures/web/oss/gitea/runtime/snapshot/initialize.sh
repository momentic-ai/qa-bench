#!/bin/sh
set -eu

export USER=git
export GITEA_CUSTOM=/data/gitea
. /fixture/app/snapshot/env.sh
if [ -x /usr/bin/s6-svscan ]; then
  # Older upstream images install s6 under /usr/bin.
  s6=/usr/bin/s6-svscan
else
  # Newer upstream images install s6 under /bin.
  s6=/bin/s6-svscan
fi
exec /usr/bin/entrypoint "$s6" /etc/s6
