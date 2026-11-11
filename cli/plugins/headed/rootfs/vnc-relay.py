#!/usr/bin/env python3
# vnc-relay: join stdin/stdout to the sandbox's own VNC server (127.0.0.1:5900).
#
# This is how VNC leaves the sandbox: `vivary web` runs `<runtime> exec -i
# <container> vnc-relay` per viewer and carries the RFB stream over the
# runtime's exec channel. Nothing listens on the sandbox's network for VNC, so
# another sandbox has nothing to connect to, and there is no password or token
# to keep: only whoever can run `container exec` on the Mac gets a screen.
# stdin EOF (the viewer left) ends the relay and with it the VNC client.
import os
import selectors
import socket
import sys

PORT = int(os.environ.get('VNC_PORT', '5900'))


def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def main():
    try:
        sock = socket.create_connection(('127.0.0.1', PORT), timeout=5)
    except OSError as e:
        sys.stderr.write(f'vnc-relay: no VNC server on 127.0.0.1:{PORT} ({e}) - is the GUI running?\n')
        return 2
    sock.settimeout(None)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sel = selectors.DefaultSelector()
    sel.register(0, selectors.EVENT_READ, 'viewer')
    sel.register(sock, selectors.EVENT_READ, 'vnc')
    while True:
        for key, _ in sel.select():
            if key.data == 'viewer':
                data = os.read(0, 65536)
                if not data:
                    return 0
                sock.sendall(data)
            else:
                data = sock.recv(65536)
                if not data:
                    return 0
                write_all(1, data)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (BrokenPipeError, ConnectionResetError, KeyboardInterrupt):
        sys.exit(0)
