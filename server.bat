@echo off
setlocal

REM Optional build-time flags. Uncomment or set them before running this script.
REM These values are baked into the frontend during `pnpm run build`.
REM
REM Advertisement configuration:
REM Optional Google AdSense client and slot IDs for desktop and mobile ad units.
REM if not defined VITE_AD_CLIENT set "VITE_AD_CLIENT="
REM if not defined VITE_AD_CLIENT_MOBILE set "VITE_AD_CLIENT_MOBILE="
REM if not defined VITE_AD_SLOT set "VITE_AD_SLOT="
REM if not defined VITE_AD_SLOT_MOBILE set "VITE_AD_SLOT_MOBILE="

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
