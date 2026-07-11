#!/usr/bin/env python3
"""TCP forwarder: 0.0.0.0:3422 -> 127.0.0.1:3420

Bridges Windows-side n8n HTTP Request nodes to the WSL2 dashboard API
(card e4d64187). socat is not available; this pure-stdlib proxy is the
equivalent. Supervisor-managed: ensure_n8n_kanban_bridge() in fleet-supervisor.sh.

Source-IP allowlist (card 8c328df3, Chad FLAG-medium):
  Only the WSL2 Windows-host IP and loopback are allowed. The host IP is read
  once at startup from /etc/resolv.conf (the WSL2 nameserver line), which is
  the virtual gateway address Windows uses to reach WSL services. Falls back to
  loopback-only if the file is absent or unparseable -- more restrictive, never
  less. Override via N8N_BRIDGE_ALLOWED_IPS (comma-separated, e.g. "172.20.0.1").
"""
import os, socket, threading, sys, signal

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 3422
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 3420
BACKLOG = 128
BUF = 16384


def _build_allowlist() -> frozenset:
    allowed = {"127.0.0.1", "::1"}
    env_override = os.environ.get("N8N_BRIDGE_ALLOWED_IPS", "").strip()
    if env_override:
        for ip in env_override.split(","):
            ip = ip.strip()
            if ip:
                allowed.add(ip)
        return frozenset(allowed)
    # Auto-detect the Windows host IP from the WSL2 nameserver entry.
    try:
        with open("/etc/resolv.conf") as f:
            for line in f:
                if line.startswith("nameserver"):
                    win_ip = line.split()[1].strip()
                    allowed.add(win_ip)
                    break
    except OSError:
        pass
    return frozenset(allowed)


ALLOWED_HOSTS: frozenset = _build_allowlist()


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
    peer_ip = client.getpeername()[0]
    if peer_ip not in ALLOWED_HOSTS:
        print(f"n8n-kanban-bridge: rejected connection from {peer_ip} (not in allowlist)", flush=True)
        client.close()
        return
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
    print(
        f"n8n-kanban-bridge: listening 0.0.0.0:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}"
        f" | allowlist={sorted(ALLOWED_HOSTS)}",
        flush=True,
    )
    while True:
        try:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()
        except OSError:
            break


if __name__ == "__main__":
    main()
