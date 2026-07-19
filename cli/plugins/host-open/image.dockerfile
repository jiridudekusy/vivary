# Open URLs in the host browser / files in the host editor (vivary broker).
COPY plugins/host-open/rootfs/host-open.sh /usr/local/bin/host-open
RUN chmod +x /usr/local/bin/host-open \
    && ln -s /usr/local/bin/host-open /usr/local/bin/xdg-open \
    && ln -s /usr/local/bin/host-open /usr/local/bin/open \
    && ln -s /usr/local/bin/host-open /usr/local/bin/code
ENV BROWSER=/usr/local/bin/xdg-open
