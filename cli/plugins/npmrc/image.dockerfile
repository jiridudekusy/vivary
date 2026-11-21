# npm reads the credentials vivary hands into RAM at every start
# (/run/vivary/npmrc) as its global config. A dangling link is ignored by npm,
# so sandboxes without --npmrc are unaffected.
RUN mkdir -p /usr/etc && ln -sf /run/vivary/npmrc /usr/etc/npmrc
