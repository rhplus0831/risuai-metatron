@echo off
setlocal

call npm install -g pnpm@10.34.1
call pnpm install
call pnpm run build

REM Optional runtime flags. These can be overridden when invoking the script.
REM
REM Server runtime:
REM NODE_ENV selects production behavior for Node dependencies and middleware.
REM PORT controls which port the self-hosted server listens on.
REM if not defined NODE_ENV set "NODE_ENV=production"
REM if not defined PORT set "PORT=6001"

REM Reverse proxy support:
REM Enable this only when running behind a trusted reverse proxy such as
REM Nginx, Caddy, Cloudflare Tunnel, or a managed platform that forwards client IPs.
REM if not defined TRUST_PROXY set "TRUST_PROXY=1"

call pnpm run runserver
