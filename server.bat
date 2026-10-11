@echo off
setlocal

call pnpm install
call pnpm run build
call pnpm run server
