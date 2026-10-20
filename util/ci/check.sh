#!/usr/bin/env bash
# The CI gate (docs/structure/build-test-platforms.md, "CI"): installs from the lockfile, then
# runs the type check, the formatting check, the test inventory, the tests without the `slow` tag,
# and the build. It stops at the first failing step with that step's exit code and prints every
# step's duration.
#
# Needs Bash 5 or later (for EPOCHREALTIME), Node 24 or later, and the pnpm version that
# `packageManager` in package.json names (in CI the job runs `corepack enable` first). When
# PNPM_STORE_DIR is set, `pnpm install` uses it as the store (the CI cache); otherwise pnpm's
# default store. It needs no credentials.
#
# Usage: util/ci/check.sh (from any directory; it runs in the repository root)
set -euo pipefail
if [ -z "${EPOCHREALTIME:-}" ]; then
    echo "[ci] Bash 5 or later is required, found $BASH_VERSION" >&2
    exit 1
fi
cd "$(dirname "$0")/../.."

names=()
durations=()

seconds() {
    printf '%d.%d s' $(($1 / 1000000)) $(($1 % 1000000 / 100000))
}

summary() {
    local i
    echo
    echo "[ci] step durations:"
    for i in "${!names[@]}"; do
        printf '[ci]   %-14s %s\n' "${names[$i]}" "${durations[$i]}"
    done
}

step() {
    local name=$1
    shift
    echo
    echo "[ci] ==> $name: $*"
    local start=${EPOCHREALTIME/./}
    local status=0
    "$@" || status=$?
    names+=("$name")
    durations+=("$(seconds $((${EPOCHREALTIME/./} - start)))$([ "$status" -eq 0 ] || echo " (failed, exit $status)")")
    if [ "$status" -ne 0 ]; then
        summary
        echo "[ci] FAIL: $name exited with $status"
        exit "$status"
    fi
}

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 24 ]; then
    echo "[ci] Node 24 or later is required, found $(node --version)" >&2
    exit 1
fi
want_pnpm=$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "").split("+")[0]')
have_pnpm=$(pnpm --version 2>/dev/null || true)
if [ "$have_pnpm" != "$want_pnpm" ]; then
    echo "[ci] pnpm $want_pnpm is required (package.json packageManager), found '${have_pnpm:-none}';" \
        "run \`corepack enable\` first" >&2
    exit 1
fi
echo "[ci] node $(node --version), pnpm $have_pnpm"

install=(pnpm install --frozen-lockfile)
if [ -n "${PNPM_STORE_DIR:-}" ]; then
    install+=(--store-dir "$PNPM_STORE_DIR")
fi

step install "${install[@]}"
step check pnpm check
step format:check pnpm format:check
step check:tests pnpm check:tests
step test env CI=1 pnpm test
step build pnpm build

summary
echo "[ci] OK"
