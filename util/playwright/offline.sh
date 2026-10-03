#!/bin/sh
# Runs a check with no network but loopback: a new user and network namespace (`unshare -rn`), so
# the dev stack, the browser, and the mocks reach each other on localhost and nothing else, whatever
# transport they use. Usage: util/playwright/offline.sh node util/playwright/checkServerSend.mjs
exec unshare -rn sh -c 'ip link set lo up && exec "$@"' sh "$@"
