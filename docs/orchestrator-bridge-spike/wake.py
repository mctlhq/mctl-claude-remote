#!/usr/bin/env python3
"""Gate-1 spike: drive the shared Codex app-server daemon over its control socket.

The daemon serves WebSocket on a Unix socket (ws://localhost/rpc), JSON-RPC text frames.

  wake.py list                      -- threads under ~/orchestrator
  wake.py turn <thread_id> <text>   -- start a turn in that thread, print the agent reply
"""
import base64
import json
import os
import socket
import struct
import sys
import time

CWD = os.path.expanduser("~/orchestrator")
SOCK = os.path.expanduser("~/.codex/app-server-control/app-server-control.sock")


class WS:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((
            "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.s.recv(1)
            if not chunk:
                raise SystemExit("socket closed during handshake")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise SystemExit(f"handshake failed: {head[:200]!r}")
        self.buf = b""

    def send_text(self, text):
        data = text.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise SystemExit("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_text(self):
        parts = []
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                mask = self._read(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(n)))
            else:
                payload = self._read(n)
            if op == 0x9:  # ping -> pong
                self.s.sendall(bytes([0x8A, 0x80 | len(payload)]) + b"\0\0\0\0" + payload)
                continue
            if op == 0x8:
                raise SystemExit("server closed websocket")
            if op in (0x1, 0x0):
                parts.append(payload)
                if b0 & 0x80:
                    return b"".join(parts).decode()


class Client:
    def __init__(self):
        self.ws = WS(SOCK)
        self.next_id = 0
        self.notes = []

    def request(self, method, params, timeout=60):
        self.next_id += 1
        rid = self.next_id
        self.ws.send_text(json.dumps({"id": rid, "method": method, "params": params}))
        self.ws.s.settimeout(timeout)
        while True:
            msg = json.loads(self.ws.recv_text())
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                if "error" in msg:
                    raise SystemExit(f"{method} error: {msg['error']}")
                return msg["result"]
            if "method" in msg:
                self.notes.append(msg)

    def next_note(self, timeout):
        if self.notes:
            return self.notes.pop(0)
        self.ws.s.settimeout(timeout)
        while True:
            msg = json.loads(self.ws.recv_text())
            if "method" in msg:
                return msg


def main():
    c = Client()
    c.request("initialize", {"clientInfo": {"name": "mctl_bridge_wake_spike", "version": "0.0.1"}})
    c.ws.send_text(json.dumps({"method": "initialized"}))
    if sys.argv[1] == "list":
        res = c.request("thread/list", {"cwd": CWD, "limit": 10})
        for t in res.get("data", []):
            print(json.dumps({k: t.get(k) for k in ("id", "name", "preview", "cwd", "updatedAt", "status")},
                             ensure_ascii=False)[:300])
        return
    thread_id, text = sys.argv[2], sys.argv[3]
    c.request("thread/resume", {"threadId": thread_id, "excludeTurns": True})
    started = c.request("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": text}]})
    print("turn/start ->", json.dumps(started)[:200])
    deadline = time.time() + 300
    while time.time() < deadline:
        msg = c.next_note(timeout=300)
        m, p = msg["method"], msg.get("params", {})
        if m == "item/completed" and p.get("item", {}).get("type") == "agentMessage":
            print("agent:", p["item"].get("text", "")[:500])
        if m == "turn/completed":
            print("turn/completed status:", json.dumps(p.get("turn", {}).get("status")))
            return
    raise SystemExit("turn did not complete in time")


if __name__ == "__main__":
    main()
