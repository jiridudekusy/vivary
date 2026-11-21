#!/bin/sh
# git credential helper for the vivary broker's git proxy URL only: the
# "password" is this sandbox's own broker token (RAM, fresh per start). The
# real git credentials stay on the Mac; this one opens nothing but the proxy.
[ "$1" = "get" ] || exit 0
cat >/dev/null
tok="$(cat /run/vivary/broker-token 2>/dev/null)"
[ -n "$tok" ] || tok="${SBX_OPEN_TOKEN:-}"
[ -n "$tok" ] || exit 0
printf 'username=vivary\npassword=%s\n' "$tok"
