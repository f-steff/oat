#!/usr/bin/env python3
"""R1 probe: enumerate LISTEN TCP ports on Linux and map them to PIDs.

Dependency-free method under test: /proc/net/tcp + /proc/net/tcp6 + /proc/*/fd.
Also reports availability/output of ss, netstat, lsof for comparison.

Run (from repo root):
  docker run --rm -v "<repo>/research:/research:ro" python:3-slim python3 /research/probe-linux-discovery.py
"""
import os
import re
import shutil
import socket
import subprocess
import threading
import time

OUR_PORTS = [46010, 46011, 46123]  # IPv4 loopback, IPv4 wildcard, IPv6 loopback
listeners = []


def serve(host, port):
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    s.listen(5)
    listeners.append(s)
    while True:
        try:
            c, _ = s.accept()
            c.close()
        except OSError:
            break


def start_listeners():
    threads = [
        threading.Thread(target=serve, args=("127.0.0.1", 46010), daemon=True),
        threading.Thread(target=serve, args=("0.0.0.0", 46011), daemon=True),
        threading.Thread(target=serve, args=("::1", 46123), daemon=True),
    ]
    for t in threads:
        t.start()
    time.sleep(0.5)


def parse_proc(path):
    rows = []
    try:
        with open(path) as f:
            lines = f.readlines()[1:]
    except FileNotFoundError:
        return rows
    for ln in lines:
        parts = ln.split()
        if len(parts) < 10:
            continue
        local, state, inode = parts[1], parts[3], parts[9]
        if state != "0A":  # LISTEN
            continue
        _, hexport = local.rsplit(":", 1)
        rows.append((int(hexport, 16), inode))
    return rows


def inode_to_pid(inodes):
    mapping = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fddir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fddir)
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(f"{fddir}/{fd}")
            except OSError:
                continue
            m = re.match(r"socket:\[(\d+)\]", target)
            if m and m.group(1) in inodes:
                mapping[m.group(1)] = pid
    return mapping


def main():
    start_listeners()
    rows = parse_proc("/proc/net/tcp") + parse_proc("/proc/net/tcp6")
    inodes = {inode for _, inode in rows}
    found_ports = sorted({p for p, _ in rows})
    pid_of = inode_to_pid(inodes)

    print("=== /proc/net/tcp + /proc/net/tcp6 LISTEN ports ===")
    print("count:", len(found_ports))
    for p in found_ports:
        pid = next((pid_of[i] for pp, i in rows if pp == p and i in pid_of), None)
        mark = "  <== OUR LISTENER" if p in OUR_PORTS else ""
        print(f"  port {p} pid={pid}{mark}")

    missing = [p for p in OUR_PORTS if p not in found_ports]
    print(("PASS" if not missing else "FAIL") + " /proc enumeration found all our listeners"
          + (f" (missing {missing})" if missing else ""))

    print("\n=== external tools ===")
    for tool in ("ss", "netstat", "lsof"):
        path = shutil.which(tool)
        print(f"{tool}: {path or 'MISSING'}")
        if path:
            for args in (["-ltnp"], ["-ltn"], ["-nP", "-iTCP", "-sTCP:LISTEN"]):
                try:
                    r = subprocess.run([tool, *args], capture_output=True, text=True, timeout=5)
                except Exception as e:  # noqa: BLE001
                    print(f"  {args}: err {e}")
                    continue
                if r.returncode == 0 and r.stdout.strip():
                    print(f"  {args} -> {len(r.stdout.splitlines())} lines; sample:")
                    for line in r.stdout.splitlines()[:6]:
                        print("    " + line)
                    break


if __name__ == "__main__":
    main()
