#!/usr/bin/env bash
# Materialize the imported npmrc as the container-local ~/.npmrc, expanding
# ${VAR} references from the environment (vars are injected by the vivary
# CLI at start; unknown references are left intact so npm can report them).
[ "${SANDBOX_NPMRC:-0}" = "1" ] || exit 0
src="$HOME/.config/npmrc-import"
[ -f "$src" ] || exit 0
perl -pe 's/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/defined $ENV{$1} ? $ENV{$1} : $&/ge' \
    "$src" > "$HOME/.npmrc"
chmod 600 "$HOME/.npmrc"
