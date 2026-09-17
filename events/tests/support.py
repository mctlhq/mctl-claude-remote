"""Test support: a throwaway valkey-server and a fake Claude Code client."""

from __future__ import annotations

import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

EVENTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVENTS))

from mctl_events.valkey import Connection, Endpoint  # noqa: E402

VALKEY_SERVER = shutil.which("valkey-server") or shutil.which("redis-server")


def requires_valkey(cls):
    return unittest.skipUnless(VALKEY_SERVER, "valkey-server not installed")(cls)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ValkeyServer:
    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="valkey-test-")
        self.port = _free_port()
        self.proc = subprocess.Popen(
            [VALKEY_SERVER, "--port", str(self.port), "--bind", "127.0.0.1", "--save", "",
             "--appendonly", "no", "--dir", self.dir],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.url = f"redis://127.0.0.1:{self.port}/0"
        deadline = time.time() + 10
        while True:
            try:
                Connection(Endpoint.from_url(self.url)).execute("PING")
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.05)

    def client(self) -> Connection:
        return Connection(Endpoint.from_url(self.url))

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=10)
        shutil.rmtree(self.dir, ignore_errors=True)


def envelope(event_id: str = "telegram:evt:v1:7:42:1001", **overrides: Any) -> dict[str, Any]:
    doc = {
        "specversion": "mctl.events/v1",
        "id": event_id,
        "type": "telegram.message.created",
        "source": "mctl-telegram",
        "occurred_at": "2026-09-17T08:00:00Z",
        "correlation_id": "corr-" + event_id.replace(":", "-"),
        "subject": {"kind": "telegram.message", "account_id": "7", "chat_id": "42",
                    "message_id": "1001", "peer": "user:42"},
    }
    doc.update(overrides)
    return doc


POLICY = {
    "group": "claude-remote",
    "consumer": "test-consumer",
    "block_ms": 200,
    "routes": [
        {"stream": "mctl:events:telegram", "sources": ["mctl-telegram"],
         "types": ["telegram.message.*"], "subject": {"account_id": ["7"]}},
    ],
}


class FakeClaude:
    """Speaks the client half of MCP stdio to a spawned adapter process."""

    def __init__(self, url: str, policy: dict[str, Any]) -> None:
        self.dir = tempfile.mkdtemp(prefix="adapter-test-")
        policy_path = Path(self.dir) / "policy.json"
        policy_path.write_text(json.dumps(policy))
        env = {**os.environ, "MCTL_EVENTS_VALKEY_URL": url, "MCTL_EVENTS_POLICY": str(policy_path),
               "PYTHONPATH": str(EVENTS)}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "mctl_events.channel"], cwd=EVENTS, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.messages: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()
        self._id = 0

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.messages.put(json.loads(line))

    def _pump_err(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr.append(line)

    def send(self, message: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._id += 1
        self.send({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        return self.wait(lambda m: m.get("id") == self._id)

    def wait(self, predicate, timeout: float = 10.0) -> dict[str, Any]:
        deadline = time.time() + timeout
        skipped = []
        try:
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise AssertionError(f"timed out; stderr={''.join(self.stderr)[-2000:]}")
                try:
                    message = self.messages.get(timeout=remaining)
                except queue.Empty:
                    raise AssertionError(f"timed out; stderr={''.join(self.stderr)[-2000:]}") from None
                if predicate(message):
                    return message
                skipped.append(message)
        finally:
            for message in skipped:
                self.messages.put(message)

    def notification(self, timeout: float = 10.0) -> dict[str, Any]:
        return self.wait(lambda m: m.get("method") == "notifications/claude/channel", timeout)

    def no_notification(self, seconds: float) -> None:
        try:
            message = self.notification(timeout=seconds)
        except AssertionError:
            return
        raise AssertionError(f"unexpected notification: {message}")

    def handshake(self) -> dict[str, Any]:
        init = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": {"name": "fake-claude", "version": "0"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return init

    def call(self, name: str, **arguments: Any) -> dict[str, Any]:
        reply = self.request("tools/call", {"name": name, "arguments": arguments})
        result = reply["result"]
        text = result["content"][0]["text"]
        return {"isError": result.get("isError", False), "body": text if result.get("isError") else json.loads(text)}

    def kill(self) -> None:
        self.proc.kill()
        self.proc.wait(timeout=10)

    def close(self) -> None:
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.kill()
        shutil.rmtree(self.dir, ignore_errors=True)
