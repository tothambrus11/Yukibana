#!/usr/bin/env bash
# Answers "will this devcontainer work in THIS environment?" by probing the real
# Docker daemon. Run it on a new machine, a CI runner or a cloud sandbox before
# wondering why `supabase start` misbehaves.
#
#   cloud/dev/scripts/preflight.sh [workspace-dir]     # defaults to $PWD
#
# Exits 1 if the setup cannot work here, so CI can gate on it. Self-contained:
# copy just this file into a sandbox and run it.

set -uo pipefail
WS="${1:-$PWD}"
IMG="${PROBE_IMAGE:-alpine}"
OK=1

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; OK=0; }
note() { printf '        %s\n' "$1"; }

echo "Workspace: $WS"; echo

echo "1. Docker daemon"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  fail "no reachable Docker daemon"
  note "Without one, use a hosted Supabase project instead of local dev."
  exit 1
fi
pass "reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
if [ -f /.dockerenv ]; then
  note "this shell is itself in a container - check 3 is the one that matters"
fi
echo

echo "2. Image pull"
if docker image inspect "$IMG" >/dev/null 2>&1 || docker pull -q "$IMG" >/dev/null 2>&1; then
  pass "can pull images (first start pulls ~2GB from public.ecr.aws)"
else
  fail "cannot pull '$IMG' - registry egress blocked?"
fi
echo

# The decisive one. The CLI runs inside the devcontainer but asks the daemon to
# bind-mount workspace paths, and the daemon resolves them on ITS host. If this
# path is not valid there, edge functions and Studio snippets mount empty.
echo "3. Bind mounts from this workspace path"
SENTINEL=".preflight-$$-$RANDOM"; VALUE="probe-$$-$RANDOM"
if echo "$VALUE" > "$WS/$SENTINEL" 2>/dev/null; then
  GOT="$(docker run --rm -v "$WS:/probe" "$IMG" cat "/probe/$SENTINEL" 2>&1)"
  rm -f "$WS/$SENTINEL"
  if [ "$GOT" = "$VALUE" ]; then
    pass "the daemon mounts this exact path and sees the real contents"
  else
    fail "the daemon does NOT see this workspace at '$WS'"
    note "got: ${GOT:-<empty>}"
    note "Empty = daemon silently created an empty dir; 'mounts denied' = refused."
    note "Fix: make the workspace path identical on the host and in here."
  fi
else
  fail "workspace not writable, cannot probe"
fi
echo

echo "4. host.docker.internal"
GW="$(docker run --rm --add-host=host.docker.internal:host-gateway "$IMG" \
      getent hosts host.docker.internal 2>/dev/null | awk '{print $1}' | head -1)"
if [ -n "$GW" ]; then
  pass "resolves to $GW"
else
  fail "host-gateway did not resolve (needs Docker >= 20.10)"
  note "Otherwise set SUPABASE_SERVICES_HOSTNAME to the bridge gateway, usually 172.17.0.1."
fi
echo

echo "VERDICT"
[ "$OK" = 1 ] && { echo "  This devcontainer should work here."; exit 0; }
echo "  This devcontainer will NOT work here as configured."
exit 1
