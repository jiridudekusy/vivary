# uunpm: Plus4U safe-install wrappers (uu-safe-* family) baked in globally.
#
# The packages live ONLY on repo.plus4u.net/repository/public-javascript (not on
# npmjs.org), which serves them anonymously — no credentials in the build.
#
# Baked rather than installed at boot for two reasons: uunpm delegates via
# `npx uu-safe-install`, and npx resolves a bin from the GLOBAL prefix before
# touching the network, so a baked install makes the delegation work offline;
# and a boot-time install would need the registry (and the npmrc plugin) up on
# every single start.
#
# UU_SAFE_SPECS arrives as name@version for every package, resolved on the host
# by the plugin: it cache-busts the layer the moment any of them ships a new
# version (same reasoning as agent-claude), and pinning each package separately
# avoids assuming the family always releases in lockstep. Unquoted on purpose —
# the shell must split it into arguments.
ARG UUNPM_REGISTRY=https://repo.plus4u.net/repository/public-javascript/
ARG UU_SAFE_SPECS="uu-safe-npm uu-safe-npx uu-safe-install uu-safe-clean-install uu-safe-update"
# shellcheck disable=SC2086
RUN npm install -g --registry="$UUNPM_REGISTRY" $UU_SAFE_SPECS \
    && npm cache clean --force \
    && uunpm --help >/dev/null && uunpx --help >/dev/null

# Staged at a neutral path; the entrypoint hook links it into ~/.local/bin only
# when the sandbox opted in, so npm/npx stay untouched without the flag.
COPY plugins/uunpm/rootfs/uunpm-shim.sh /usr/local/lib/vivary-uunpm-shim
RUN chmod 755 /usr/local/lib/vivary-uunpm-shim
