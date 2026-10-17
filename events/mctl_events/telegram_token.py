"""The read-only mctl-telegram worker token used to hydrate telegram.message.* events.

Worker tokens are bounded (30 days by default, mctl-telegram#412), and the one
this device holds expired unnoticed on 2026-10-17: every Telegram event after
that was acked `failed` until a human re-minted it and the pod was restarted.
This module removes both manual steps (mctlhq/mctl-claude-remote#82).

Two token sources are kept, and the one from the newer chain wins:

  - the seed: a file the operator controls (Vault -> ExternalSecret). A human
    mint is written here, so re-minting needs no access to the pod;
  - the state file: renewals this device made itself, under /workspace/.claude
    so they survive a restart the same way .credentials.json does.

`renew` exchanges the current token for a fresh one through mctl-telegram's
POST /api/mcp/worker-token/renew once less than a third of its lifetime is
left. The server copies identity and scopes from the presented token and caps
the chain at a year from the human mint, so nothing here can widen what the
credential grants or keep it alive forever.

`header` is the MCP server's headersHelper: Claude Code runs it when it
connects, so a renewed token is used on the next connection without a pod
restart. It records the expiry of the token it handed out; `renew` exits with
RECYCLE when that token is about to lapse while a newer one is available, and
the entrypoint then relaunches the session in-pod.

Renewal is fail-open: a failed attempt keeps the current token, which is still
valid because renewal starts with a third of the lifetime left, and reports
through the Pushgateway metrics, which alert long before expiry.

Stdlib only, and runnable as a plain script: headersHelper starts it by path
from whatever working directory Claude Code chooses.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import http.client
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

# Mirrors mctl-telegram's workertoken.maxRenewalChain. Used only to report how
# long the chain has left; the server enforces the real limit.
MAX_RENEWAL_CHAIN_S = 365 * 24 * 3600
# Renew once remaining lifetime falls below lifetime / RENEW_AT_FRACTION, the
# same rule as the mctl-telegram canary.
RENEW_AT_FRACTION = 3
# Exit codes of `renew`.
OK, FAILED, RECYCLE = 0, 1, 10


@dataclass(frozen=True)
class Token:
    raw: str
    exp: int
    iat: int
    orig_iat: int
    jti: str

    @property
    def chain_deadline(self) -> int:
        return self.orig_iat + MAX_RENEWAL_CHAIN_S

    def rank(self) -> tuple[int, int]:
        # A newer chain beats an older one even when the older one's latest
        # renewal expires later: a human re-mint usually means the old chain
        # was revoked or is ending, and must take over at once.
        return (self.orig_iat, self.exp)


def parse(raw: str) -> Token | None:
    """Read a JWT's timing claims without verifying it: the server verifies,
    this only decides when to renew. None for anything that is not a JWT with
    an integer exp."""
    raw = raw.strip()
    parts = raw.split(".")
    if len(parts) != 3 or not parts[1]:
        return None
    try:
        body = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except (binascii.Error, ValueError):
        return None
    if not isinstance(body, dict):
        return None
    exp, iat, orig = body.get("exp"), body.get("iat"), body.get("orig_iat")
    if not isinstance(exp, int) or isinstance(exp, bool):
        return None
    iat = iat if isinstance(iat, int) and not isinstance(iat, bool) else exp - 30 * 24 * 3600
    orig = orig if isinstance(orig, int) and not isinstance(orig, bool) and orig > 0 else iat
    jti = body.get("jti") if isinstance(body.get("jti"), str) else ""
    return Token(raw=raw, exp=exp, iat=iat, orig_iat=orig, jti=jti)


def read_token(path: Path | None) -> Token | None:
    if path is None:
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        log(f"WARN cannot read {path}: {e}")
        return None
    tok = parse(text)
    if tok is None and text.strip():
        log(f"WARN {path} does not hold a JWT with an exp claim; ignoring it")
    return tok


def current(seed: Path, state: Path) -> Token | None:
    candidates = [t for t in (read_token(seed), read_token(state)) if t is not None]
    return max(candidates, key=Token.rank) if candidates else None


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def renew_url(mcp_url: str) -> str:
    u = urllib.parse.urlsplit(mcp_url)
    return urllib.parse.urlunsplit((u.scheme, u.netloc, "/api/mcp/worker-token/renew", "", ""))


def call_renew(url: str, token: Token, timeout: float = 30.0) -> Token:
    req = urllib.request.Request(url, data=b"", method="POST",
                                 headers={"Authorization": f"Bearer {token.raw}", "Content-Length": "0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - https enforced by the caller
            body = json.loads(resp.read(65536))
    except urllib.error.HTTPError as e:
        # The error body is a short JSON message from the server, never a token.
        # Read it under its own guard: a sibling except does not cover this.
        try:
            detail = e.read(512).decode("utf-8", "replace").strip()
        except (OSError, ValueError, http.client.HTTPException):
            detail = "<error body unreadable>"
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
        raise RuntimeError(f"request failed: {e}") from None
    new = parse(body.get("worker_token", "")) if isinstance(body, dict) else None
    if new is None:
        raise RuntimeError("response carried no parseable worker_token")
    if new.exp <= token.exp:
        raise RuntimeError("renewed token does not outlive the current one")
    return new


def push_metrics(url: str, instance: str, token: Token | None, renew_ok: int | None,
                 served: int | None, now: int) -> None:
    """PUT the gauges for this device's group to the Pushgateway, replacing its
    previous push. A gauge is omitted, not zeroed, when it cannot be computed:
    a 0 would read as "already expired". Never raises: a broken push must not
    swallow the exit code that tells the entrypoint to relaunch the session."""
    lines = []
    if token is not None:
        lines += ["# TYPE mctl_claude_remote_telegram_token_expires_in_seconds gauge",
                  f"mctl_claude_remote_telegram_token_expires_in_seconds {token.exp - now}",
                  "# TYPE mctl_claude_remote_telegram_token_chain_expires_in_seconds gauge",
                  f"mctl_claude_remote_telegram_token_chain_expires_in_seconds {token.chain_deadline - now}"]
    if served is not None:
        # The token the session actually connected with, which can lag the
        # newest one on disk until the session reconnects.
        lines += ["# TYPE mctl_claude_remote_telegram_token_served_expires_in_seconds gauge",
                  f"mctl_claude_remote_telegram_token_served_expires_in_seconds {served - now}"]
    if renew_ok is not None:
        lines += ["# TYPE mctl_claude_remote_telegram_token_renew_ok gauge",
                  f"mctl_claude_remote_telegram_token_renew_ok {renew_ok}"]
    lines += ["# TYPE mctl_claude_remote_telegram_token_last_check_timestamp_seconds gauge",
              f"mctl_claude_remote_telegram_token_last_check_timestamp_seconds {now}"]
    # One group per device, so two devices on one Pushgateway cannot overwrite
    # each other's gauges.
    path = "/metrics/job/claude-remote-telegram-token/instance/" + urllib.parse.quote(instance, safe="")
    try:
        req = urllib.request.Request(url.rstrip("/") + path,
                                     data=("\n".join(lines) + "\n").encode(), method="PUT",
                                     headers={"Content-Type": "text/plain; version=0.0.4"})
        with urllib.request.urlopen(req, timeout=10):  # noqa: S310 - in-cluster URL from config
            pass
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
        log(f"WARN metrics push failed: {e}")


def log(msg: str) -> None:
    print(f"[telegram-token] {msg}", file=sys.stderr, flush=True)


def renew(args: argparse.Namespace, now: int | None = None) -> int:
    now = int(time.time()) if now is None else now
    tok = current(args.seed, args.state)
    renew_ok: int | None = None
    rc = OK
    if tok is None:
        log("ERROR no readable worker token in the seed or the state file")
        rc = FAILED
    elif tok.exp <= now:
        log(f"ERROR worker token expired at {iso(tok.exp)}; an administrator must mint a new one "
            "and write it to the seed (Vault)")
        rc = FAILED
    elif tok.exp - now < max(tok.exp - tok.iat, 1) // RENEW_AT_FRACTION:
        try:
            new = call_renew(renew_url(args.mcp_url), tok)
        except RuntimeError as e:
            log(f"WARN renewal failed, keeping the current token (expires {iso(tok.exp)}): {e}")
            renew_ok, rc = 0, FAILED
        else:
            try:
                write_atomic(args.state, new.raw + "\n")
            except OSError as e:
                # The server has issued the token, but without the state file
                # nothing would use it; the current one is still valid.
                log(f"ERROR renewed jti={new.jti or '-'} but cannot keep it, keeping the current "
                    f"token (expires {iso(tok.exp)}): {e}")
                renew_ok, rc = 0, FAILED
            else:
                log(f"renewed jti={new.jti or '-'} expires={iso(new.exp)} chain_ends={iso(new.chain_deadline)}")
                tok, renew_ok = new, 1
    served = read_served(args.served)
    if rc == OK and tok is not None and served is not None:
        if tok.exp > served and served - now < args.recycle_before:
            rc = recycle_once(args.served, served, tok)
    if args.pushgateway:
        push_metrics(args.pushgateway, args.instance, tok, renew_ok, served, now)
    return rc


def recycle_once(served_path: Path, served: int, tok: Token) -> int:
    """RECYCLE at most once per served token. A relaunched session rewrites the
    served file on connect; if it stays the same, either the session did not
    reconnect or the header could not record it, and relaunching again every
    hour would only throw away in-flight work. The served_expires_in_seconds
    gauge keeps the first case visible."""
    marker = served_path.with_name(served_path.name + ".recycled")
    if read_served(marker) == served:
        log(f"WARN session still reports a token expiring {iso(served)} after a relaunch; "
            "not relaunching again")
        return OK
    try:
        write_atomic(marker, f"{served}\n")
    except OSError as e:
        log(f"WARN cannot record the relaunch, so not relaunching: {e}")
        return OK
    log(f"session connected with a token expiring {iso(served)}; a newer one expires "
        f"{iso(tok.exp)}: relaunch the session to reconnect")
    return RECYCLE


def read_served(path: Path | None) -> int | None:
    if path is None:
        return None
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def header(args: argparse.Namespace) -> int:
    tok = current(args.seed, args.state)
    if tok is None:
        log("ERROR no readable worker token in the seed or the state file")
        return FAILED
    if args.served is not None:
        try:
            write_atomic(args.served, f"{tok.exp}\n")
        except OSError as e:
            log(f"WARN could not record the served token's expiry: {e}")
    print(json.dumps({"Authorization": f"Bearer {tok.raw}"}))
    return OK


def iso(ts: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("header", "renew"):
        p = sub.add_parser(name)
        p.add_argument("--seed", type=Path, required=True, help="operator-provided token file (Vault)")
        p.add_argument("--state", type=Path, required=True, help="where this device keeps its renewals")
        p.add_argument("--served", type=Path, help="expiry of the token last handed to Claude Code")
    r = sub.choices["renew"]
    r.add_argument("--mcp-url", required=True)
    r.add_argument("--pushgateway", default="")
    r.add_argument("--instance", default="claude-remote", help="Pushgateway instance label (the device name)")
    r.add_argument("--recycle-before", type=int, default=2 * 24 * 3600,
                   help="relaunch the session when its token has less than this many seconds left")
    args = ap.parse_args(argv)
    if args.cmd == "renew" and not args.mcp_url.startswith("https://"):
        log("ERROR --mcp-url must be https")
        return FAILED
    return header(args) if args.cmd == "header" else renew(args)


if __name__ == "__main__":
    sys.exit(main())
