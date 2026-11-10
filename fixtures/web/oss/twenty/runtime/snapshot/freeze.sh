#!/bin/sh
set -eu
sh /fixture/app/snapshot/verify.sh
# Stop the server before its database so request handlers cannot write during capture.
killall -TERM node
for attempt in $(seq 1 60); do
  if ! pidof node >/dev/null; then
    break
  fi
  sleep 1
done
if pidof node >/dev/null; then
  echo 'Twenty did not stop cleanly.' >&2
  exit 1
fi
redis_directory=$(redis-cli --raw CONFIG GET dir | tail -n 1)
redis_file=$(redis-cli --raw CONFIG GET dbfilename | tail -n 1)
redis-cli shutdown nosave
rm -f "$redis_directory/$redis_file"
su-exec postgres pg_ctl -D /var/lib/postgresql/data -m fast -w stop
test ! -f /var/lib/postgresql/data/postmaster.pid
rm -f /tmp/postgres.log /tmp/setup-complete
touch /fixture/seeded-state
