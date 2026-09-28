#!/usr/bin/env sh
set -eu

npm install -g pnpm@10.34.1
pnpm install
pnpm run build

# Optional runtime flags. These can be overridden when invoking the script.
#
# Server runtime:
# NODE_ENV selects production behavior for Node dependencies and middleware.
# PORT controls which port the self-hosted server listens on.
# export NODE_ENV="${NODE_ENV:-production}"
# export PORT="${PORT:-6001}"

# Reverse proxy support:
# Enable this only when running behind a trusted reverse proxy such as 
# Nginx, Caddy, Cloudflare Tunnel, or a managed platform that forwards client IPs.
# export TRUST_PROXY="${TRUST_PROXY:-1}"

pnpm run runserver
