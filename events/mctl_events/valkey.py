"""A deliberately small, dependency-free Valkey (RESP2) client.

Only what the Streams consumer needs. The image carries no pip toolchain, and a
pinned third-party client would be one more thing to keep patched for a handful
of commands. Every call is synchronous on its own socket and guarded by a lock;
blocking reads get a dedicated connection so they never stall acknowledgements.
"""

from __future__ import annotations

import socket
import threading
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse


class ValkeyError(RuntimeError):
    """The server answered with an error reply."""


class ValkeyConnectionError(ConnectionError):
    """The connection failed or closed mid-reply."""


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int
    username: str | None
    password: str | None
    db: int

    @classmethod
    def from_url(cls, url: str, password: str | None = None) -> "Endpoint":
        parsed = urlparse(url)
        if parsed.scheme not in ("redis", "valkey"):
            raise ValueError("only redis:// or valkey:// URLs are supported (in-cluster, no TLS)")
        if not parsed.hostname:
            raise ValueError("URL has no host")
        db = int(parsed.path.lstrip("/") or 0)
        return cls(
            host=parsed.hostname,
            port=parsed.port or 6379,
            username=unquote(parsed.username) if parsed.username else None,
            password=password if password is not None else (unquote(parsed.password) if parsed.password else None),
            db=db,
        )


def _encode(args: tuple[Any, ...]) -> bytes:
    out = [b"*%d\r\n" % len(args)]
    for arg in args:
        if isinstance(arg, bytes):
            data = arg
        elif isinstance(arg, str):
            data = arg.encode("utf-8")
        elif isinstance(arg, (int, float)) and not isinstance(arg, bool):
            data = str(arg).encode()
        else:
            raise TypeError(f"unsupported argument type {type(arg).__name__}")
        out.append(b"$%d\r\n%s\r\n" % (len(data), data))
    return b"".join(out)


class Connection:
    def __init__(self, endpoint: Endpoint, timeout: float = 10.0) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
        self._sock: socket.socket | None = None
        self._buf = b""
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------
    def _connect(self) -> None:
        sock = socket.create_connection((self.endpoint.host, self.endpoint.port), timeout=self.timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock, self._buf = sock, b""
        try:
            if self.endpoint.password is not None:
                if self.endpoint.username:
                    self._roundtrip(("AUTH", self.endpoint.username, self.endpoint.password), self.timeout)
                else:
                    self._roundtrip(("AUTH", self.endpoint.password), self.timeout)
            if self.endpoint.db:
                self._roundtrip(("SELECT", self.endpoint.db), self.timeout)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock, self._buf = None, b""

    # -- protocol ----------------------------------------------------------
    def _read_line(self) -> bytes:
        while b"\r\n" not in self._buf:
            self._fill()
        line, self._buf = self._buf.split(b"\r\n", 1)
        return line

    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n + 2:
            self._fill()
        data, self._buf = self._buf[:n], self._buf[n + 2 :]
        return data

    def _fill(self) -> None:
        assert self._sock is not None
        chunk = self._sock.recv(65536)
        if not chunk:
            raise ValkeyConnectionError("connection closed by server")
        self._buf += chunk

    def _read_reply(self) -> Any:
        line = self._read_line()
        kind, rest = line[:1], line[1:]
        if kind == b"+":
            return rest.decode()
        if kind == b"-":
            return ValkeyError(rest.decode())
        if kind == b":":
            return int(rest)
        if kind == b"$":
            n = int(rest)
            return None if n < 0 else self._read_exact(n)
        if kind == b"*":
            n = int(rest)
            return None if n < 0 else [self._read_reply() for _ in range(n)]
        raise ValkeyConnectionError(f"unexpected reply type {kind!r}")

    def _roundtrip(self, args: tuple[Any, ...], timeout: float | None) -> Any:
        assert self._sock is not None
        self._sock.settimeout(timeout)
        self._sock.sendall(_encode(args))
        reply = self._read_reply()
        if isinstance(reply, ValkeyError):
            raise reply
        return reply

    def execute(self, *args: Any, timeout: float | None = None) -> Any:
        """Run one command. A transport failure drops the socket so the next call reconnects."""

        with self._lock:
            try:
                if self._sock is None:
                    self._connect()
                return self._roundtrip(args, self.timeout if timeout is None else timeout)
            except ValkeyError:
                raise
            except (OSError, ValkeyConnectionError) as exc:
                self.close()
                raise ValkeyConnectionError(str(exc)) from exc
