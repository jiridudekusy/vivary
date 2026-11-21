# git proxy (plugins/git): git's ssh command and a credential helper for the
# broker, and /etc/gitconfig pulling in the per-start config from RAM (git
# ignores a missing include, so sandboxes without git rules are unaffected).
COPY plugins/git/rootfs/vivary-git-ssh.mjs /usr/local/bin/vivary-git-ssh
COPY plugins/git/rootfs/vivary-git-credential.sh /usr/local/bin/vivary-git-credential
RUN chmod +x /usr/local/bin/vivary-git-ssh /usr/local/bin/vivary-git-credential \
    && git config --system include.path /run/vivary/gitconfig
