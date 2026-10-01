# Paseo daemon + CLI. The daemon has to live WHERE THE AGENTS ARE — it drives
# them through their own CLI installs and logins, which in vivary are inside the
# container. ~35 MB, almost all of it @getpaseo/server.
#
# PASEO_VERSION is a cache key, not a pin (same convention as the agent
# plugins): the host resolves the current version so this layer busts exactly
# when a new Paseo ships, while the install itself takes @latest.
#
# The `latest` dist-tag is deliberate over `beta`. node-pty ships prebuilt
# binaries, so the image's ignore-scripts posture does not break it.
ARG PASEO_VERSION=latest
RUN echo "paseo cache key: ${PASEO_VERSION}" > /dev/null \
    && npm install -g @getpaseo/cli@latest \
    && paseo --version > /dev/null
