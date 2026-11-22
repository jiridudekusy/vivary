#!/usr/bin/env bash
# npm credentials from the host ~/.npmrc. Opt in: SANDBOX_NPMRC=1
#
# They arrive in RAM after the start (/run/vivary/npmrc, handed in by vivary)
# and npm reads them as its global config through the /usr/etc/npmrc symlink —
# nothing to do here. Only a container from before that (no /run/vivary tmpfs)
# still materializes ~/.npmrc from the file on the Mac, expanding ${VAR} from
# its baked env.
[ "${SANDBOX_NPMRC:-0}" = "1" ] || exit 0
awk '$2 == "/run/vivary" && $3 == "tmpfs" { found = 1 } END { exit !found }' /proc/mounts && exit 0
src="$HOME/.config/npmrc-import"
[ -f "$src" ] || exit 0
perl -pe 's/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/defined $ENV{$1} ? $ENV{$1} : $&/ge' \
    "$src" > "$HOME/.npmrc"
chmod 600 "$HOME/.npmrc"
