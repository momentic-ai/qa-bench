#!/bin/sh
set -eu
sh /fixture/app/snapshot/verify.sh
# Metabase's shutdown hook closes its H2 application database before copying it out of /tmp.
killall -TERM java
for attempt in $(seq 1 60); do
  if ! pidof java >/dev/null; then
    break
  fi
  sleep 1
done
if pidof java >/dev/null; then
  echo 'Metabase did not stop cleanly.' >&2
  exit 1
fi
test -f /tmp/metabase.db/metabase.db.mv.db
test ! -f /tmp/metabase.db/metabase.db.lock.db
mv /tmp/metabase.db /fixture/metabase.db
rm -f /fixture/metabase.db/metabase.db.trace.db
su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop
test ! -f /var/lib/postgresql/data/postmaster.pid
rm -f /tmp/postgres.log
touch /fixture/seeded-state
