#!/usr/bin/env python3
"""TCP forwarder: 0.0.0.0:3422 -> 127.0.0.1:3420

Bridges Windows-side n8n HTTP Request nodes to the WSL2 dashboard API
(card e4d64187). socat is not available; this pure-stdlib proxy is the
equivalent. Supervisor-managed: ensure_n8n_kanban_bridge() in fleet-supervisor.sh.
"""
import socket, threading, sys, signal

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 3422
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 3420
BACKLOG = 128
BUF = 16384


def relay(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(BUF)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def handle(client: socket.socket) -> None:
    try:
        srv = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=10)
    except OSError:
        client.close()
        return
    for t in (
        threading.Thread(target=relay, args=(client, srv), daemon=True),
        threading.Thread(target=relay, args=(srv, client), daemon=True),
    ):
        t.start()


def main() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(BACKLOG)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f"n8n-kanban-bridge: listening 0.0.0.0:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        try:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()
        except OSError:
            break


if __name__ == "__main__":
    main()
