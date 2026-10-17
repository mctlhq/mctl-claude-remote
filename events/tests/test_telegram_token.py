"""Self-renewal of the Telegram hydration worker token (mctlhq/mctl-claude-remote#82).

A local HTTP server stands in for mctl-telegram's renew endpoint and for the
Pushgateway. The entrypoint test cuts the hydration block out of entrypoint.sh
and runs the generated headersHelper command line, so it exercises the shipped
text rather than a copy of it.
"""

from __future__ import annotations

import base64
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

from support import EVENTS  # noqa: F401 - puts the package on sys.path

from mctl_events import telegram_token as tt  # noqa: E402

ENTRYPOINT = Path(__file__).resolve().parents[2] / "entrypoint.sh"
TOOL = EVENTS / "mctl_events" / "telegram_token.py"
DAY = 24 * 3600
NOW = 1_800_000_000


def jwt(exp: int, iat: int | None = None, orig_iat: int | None = None, jti: str = "j1") -> str:
    def enc(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")
    claims: dict = {"exp": exp, "jti": jti, "aud": ["mcp-worker-ro"]}
    if iat is not None:
        claims["iat"] = iat
    if orig_iat is not None:
        claims["orig_iat"] = orig_iat
    return f"{enc({'alg': 'HS256'})}.{enc(claims)}.c2ln"


class FakeServer:
    """Answers /api/mcp/worker-token/renew with a canned response and records
    every request, including Pushgateway PUTs."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict, bytes]] = []
        self.status = 200
        self.body: dict = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                n = int(self.headers.get("Content-Length") or 0)
                outer.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(n)))
                payload = json.dumps(outer.body if self.command == "POST" else {}).encode()
                self.send_response(outer.status if self.command == "POST" else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_POST = do_PUT = _handle

            def log_message(self, *args) -> None:
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def renew_calls(self) -> list:
        return [r for r in self.requests if r[0] == "POST"]

    def metrics(self) -> dict[str, int]:
        puts = [r for r in self.requests if r[0] == "PUT"]
        if not puts:
            return {}
        out = {}
        for line in puts[-1][3].decode().splitlines():
            if line and not line.startswith("#"):
                k, v = line.split()
                out[k.removeprefix("mctl_claude_remote_telegram_token_")] = int(v)
        return out


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="tg-token-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.seed = self.dir / "seed"
        self.state = self.dir / "state" / "telegram-worker-token"
        self.served = self.dir / "served"
        self.server = FakeServer()
        self.addCleanup(self.server.close)

    def args(self, *extra: str) -> list[str]:
        return ["--seed", str(self.seed), "--state", str(self.state), "--served", str(self.served), *extra]

    def renew(self, now: int = NOW, **kw) -> int:
        ns = type("NS", (), {"seed": self.seed, "state": self.state, "served": self.served,
                             "mcp_url": self.server.url + "/mcp", "pushgateway": self.server.url,
                             "recycle_before": 2 * DAY, "instance": "dev-1", **kw})()
        return tt.renew(ns, now=now)


class ParseTest(unittest.TestCase):
    def test_reads_timing_claims(self) -> None:
        t = tt.parse(jwt(NOW + DAY, iat=NOW - DAY, orig_iat=NOW - 10 * DAY) + "\n")
        self.assertEqual((NOW + DAY, NOW - DAY, NOW - 10 * DAY, "j1"), (t.exp, t.iat, t.orig_iat, t.jti))

    def test_chain_anchors_to_iat_when_orig_iat_is_absent(self) -> None:
        # Tokens minted before orig_iat existed: the server anchors to iat too.
        self.assertEqual(NOW - DAY, tt.parse(jwt(NOW + DAY, iat=NOW - DAY)).orig_iat)

    def test_rejects_what_is_not_a_jwt_with_exp(self) -> None:
        for raw in ("", "abc", "a.b", "a.!!.c", jwt(NOW).replace(".", "..", 1)):
            self.assertIsNone(tt.parse(raw), raw)
        no_exp = jwt(NOW).split(".")
        no_exp[1] = base64.urlsafe_b64encode(b'{"iat": 1}').decode().rstrip("=")
        self.assertIsNone(tt.parse(".".join(no_exp)))


class CurrentTest(Base):
    def test_newer_chain_wins_over_a_later_expiring_older_one(self) -> None:
        # The state holds a renewal of the old chain that outlives the fresh
        # human mint; the mint must still take over at once.
        self.seed.write_text(jwt(NOW + 20 * DAY, iat=NOW, jti="new"))
        self.state.parent.mkdir()
        self.state.write_text(jwt(NOW + 25 * DAY, iat=NOW - 5 * DAY, orig_iat=NOW - 100 * DAY, jti="old"))
        self.assertEqual("new", tt.current(self.seed, self.state).jti)

    def test_within_a_chain_the_later_expiry_wins(self) -> None:
        self.seed.write_text(jwt(NOW + 5 * DAY, iat=NOW - 25 * DAY, jti="seed"))
        self.state.parent.mkdir()
        self.state.write_text(jwt(NOW + 30 * DAY, iat=NOW, orig_iat=NOW - 25 * DAY, jti="state"))
        self.assertEqual("state", tt.current(self.seed, self.state).jti)

    def test_unparseable_seed_is_ignored_not_fatal(self) -> None:
        self.seed.write_text("not a token")
        self.state.parent.mkdir()
        self.state.write_text(jwt(NOW + DAY, iat=NOW, jti="state"))
        self.assertEqual("state", tt.current(self.seed, self.state).jti)

    def test_no_token_at_all(self) -> None:
        self.assertIsNone(tt.current(self.seed, self.state))


class RenewTest(Base):
    def test_not_due_makes_no_call(self) -> None:
        self.seed.write_text(jwt(NOW + 20 * DAY, iat=NOW - 10 * DAY))
        self.assertEqual(tt.OK, self.renew())
        self.assertEqual([], self.server.renew_calls())
        self.assertFalse(self.state.exists())
        m = self.server.metrics()
        self.assertEqual(20 * DAY, m["expires_in_seconds"])
        self.assertEqual(355 * DAY, m["chain_expires_in_seconds"])
        self.assertNotIn("renew_ok", m)

    def test_due_renews_and_keeps_the_result(self) -> None:
        old = jwt(NOW + 9 * DAY, iat=NOW - 21 * DAY)
        new = jwt(NOW + 30 * DAY, iat=NOW, orig_iat=NOW - 21 * DAY)
        self.seed.write_text(old)
        self.server.body = {"worker_token": new, "expires_at": "x"}
        self.assertEqual(tt.OK, self.renew())
        [(_, path, headers, body)] = self.server.renew_calls()
        self.assertEqual("/api/mcp/worker-token/renew", path)
        self.assertEqual(f"Bearer {old}", headers["Authorization"])
        self.assertEqual(b"", body)
        self.assertEqual(new, self.state.read_text().strip())
        self.assertEqual(0o600, stat.S_IMODE(self.state.stat().st_mode))
        self.assertEqual(new, tt.current(self.seed, self.state).raw)
        m = self.server.metrics()
        self.assertEqual(1, m["renew_ok"])
        self.assertEqual(30 * DAY, m["expires_in_seconds"])

    def test_refused_renewal_keeps_the_current_token(self) -> None:
        self.seed.write_text(jwt(NOW + DAY, iat=NOW - 29 * DAY))
        self.server.status = 403
        self.server.body = {"error": "renewal window exhausted"}
        self.assertEqual(tt.FAILED, self.renew())
        self.assertFalse(self.state.exists())
        self.assertEqual(0, self.server.metrics()["renew_ok"])
        self.assertEqual(DAY, self.server.metrics()["expires_in_seconds"])

    def test_a_renewal_that_does_not_extend_is_a_failure(self) -> None:
        old = jwt(NOW + DAY, iat=NOW - 29 * DAY)
        self.seed.write_text(old)
        self.server.body = {"worker_token": old}
        self.assertEqual(tt.FAILED, self.renew())
        self.assertFalse(self.state.exists())

    def test_expired_token_is_not_sent(self) -> None:
        self.seed.write_text(jwt(NOW - 1, iat=NOW - 30 * DAY))
        self.assertEqual(tt.FAILED, self.renew())
        self.assertEqual([], self.server.renew_calls())
        self.assertLess(self.server.metrics()["expires_in_seconds"], 0)

    def test_a_renewal_that_cannot_be_kept_fails_open_and_still_reports(self) -> None:
        self.seed.write_text(jwt(NOW + DAY, iat=NOW - 29 * DAY))
        self.server.body = {"worker_token": jwt(NOW + 30 * DAY, iat=NOW, orig_iat=NOW - 29 * DAY)}
        blocker = self.dir / "blocker"
        blocker.write_text("")
        self.assertEqual(tt.FAILED, self.renew(state=blocker / "telegram-worker-token"))
        m = self.server.metrics()
        self.assertEqual(0, m["renew_ok"])
        self.assertEqual(DAY, m["expires_in_seconds"])

    def test_an_unreadable_error_body_is_a_failed_renewal(self) -> None:
        self.seed.write_text(jwt(NOW + DAY, iat=NOW - 29 * DAY))
        err = tt.urllib.error.HTTPError("u", 502, "bad gateway", {}, None)
        with mock.patch.object(err, "read", side_effect=IncompleteRead(b"")), \
                mock.patch.object(tt.urllib.request, "urlopen", side_effect=err):
            self.assertEqual(tt.FAILED, self.renew(pushgateway=""))

    def test_a_truncated_response_is_a_failed_renewal(self) -> None:
        self.seed.write_text(jwt(NOW + DAY, iat=NOW - 29 * DAY))
        with mock.patch.object(tt.urllib.request, "urlopen", side_effect=IncompleteRead(b"")):
            self.assertEqual(tt.FAILED, self.renew(pushgateway=""))

    def test_metrics_are_grouped_per_device(self) -> None:
        self.seed.write_text(jwt(NOW + 20 * DAY, iat=NOW - 10 * DAY))
        self.renew()
        [put] = [r for r in self.server.requests if r[0] == "PUT"]
        self.assertEqual("/metrics/job/claude-remote-telegram-token/instance/dev-1", put[1])

    def test_no_token_reports_without_the_token_gauges(self) -> None:
        self.assertEqual(tt.FAILED, self.renew())
        m = self.server.metrics()
        self.assertNotIn("expires_in_seconds", m)
        self.assertIn("last_check_timestamp_seconds", m)


class RecycleTest(Base):
    def setUp(self) -> None:
        super().setUp()
        self.state.parent.mkdir()
        self.state.write_text(jwt(NOW + 25 * DAY, iat=NOW - 5 * DAY, orig_iat=NOW - 40 * DAY))

    def test_session_on_an_expiring_token_is_relaunched(self) -> None:
        self.served.write_text(f"{NOW + DAY}\n")
        self.assertEqual(tt.RECYCLE, self.renew())

    def test_session_on_a_token_with_time_left_is_left_alone(self) -> None:
        self.served.write_text(f"{NOW + 3 * DAY}\n")
        self.assertEqual(tt.OK, self.renew())

    def test_no_newer_token_means_no_relaunch(self) -> None:
        # The session already holds the newest token, and renewing it fails:
        # relaunching would reconnect with the same token, so it must not.
        self.served.write_text(f"{NOW + 25 * DAY}\n")
        self.server.status = 503
        self.assertEqual(tt.FAILED, self.renew(now=NOW + 24 * DAY))

    def test_nothing_served_yet_means_no_relaunch(self) -> None:
        self.assertEqual(tt.OK, self.renew())

    def test_reports_the_expiry_of_the_token_the_session_holds(self) -> None:
        self.served.write_text(f"{NOW + DAY}\n")
        self.renew()
        self.assertEqual(DAY, self.server.metrics()["served_expires_in_seconds"])
        # After the one relaunch the guard stays quiet, but the gauge does not.
        self.assertEqual(tt.OK, self.renew(now=NOW + 3600))
        self.assertEqual(DAY - 3600, self.server.metrics()["served_expires_in_seconds"])

    def test_relaunches_once_per_served_token(self) -> None:
        # The relaunched session did not rewrite the served file: a second
        # relaunch an hour later would change nothing but lose work.
        self.served.write_text(f"{NOW + DAY}\n")
        self.assertEqual(tt.RECYCLE, self.renew())
        self.assertEqual(tt.OK, self.renew(now=NOW + 3600))
        self.served.write_text(f"{NOW + DAY + 1}\n")
        self.assertEqual(tt.RECYCLE, self.renew(now=NOW + 7200))

    def test_a_broken_pushgateway_url_keeps_the_relaunch(self) -> None:
        self.served.write_text(f"{NOW + DAY}\n")
        self.assertEqual(tt.RECYCLE, self.renew(pushgateway="pushgateway.monitoring.svc"))


class HeaderTest(Base):
    def run_header(self) -> subprocess.CompletedProcess:
        # As headersHelper runs it: by path, from an unrelated directory.
        return subprocess.run([sys.executable, str(TOOL), "header", *self.args()],
                              capture_output=True, text=True, timeout=30, cwd=self.dir)

    def test_prints_the_current_token_and_records_its_expiry(self) -> None:
        tok = jwt(NOW + 30 * DAY, iat=NOW)
        self.seed.write_text(tok + "\n")
        proc = self.run_header()
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual({"Authorization": f"Bearer {tok}"}, json.loads(proc.stdout))
        self.assertEqual(str(NOW + 30 * DAY), self.served.read_text().strip())

    def test_no_token_prints_nothing(self) -> None:
        proc = self.run_header()
        self.assertEqual(tt.FAILED, proc.returncode)
        self.assertEqual("", proc.stdout)

    def test_an_unexpected_error_fails_the_check_instead_of_crashing(self) -> None:
        self.seed.write_text(jwt(NOW + 25 * DAY, iat=NOW - 5 * DAY))
        self.served.write_text(f"{-10 ** 30}\n")  # out of range for gmtime
        self.assertEqual(tt.FAILED, tt.main(["renew", *self.args(), "--mcp-url", "https://x/mcp"]))

    def test_cli_refuses_a_plain_http_mcp_url(self) -> None:
        self.assertEqual(tt.FAILED, tt.main(["renew", *self.args(), "--mcp-url", "http://x/mcp"]))


class EntrypointConfigTest(Base):
    """The MCP config the entrypoint writes: valid JSON, no token in it, and a
    headersHelper whose command line actually yields the header."""

    def block(self) -> str:
        lines = ENTRYPOINT.read_text(encoding="utf-8").splitlines()
        start = lines.index('  MCTL_EVENTS_TELEGRAM_SERVER=""')
        end = lines.index('  } > "$MCTL_EVENTS_MCP_CONFIG"')
        return "\n".join(lines[start:end + 1]) + "\n"

    def test_config_uses_the_helper_and_holds_no_token(self) -> None:
        tok = jwt(NOW + 30 * DAY, iat=NOW)
        self.seed.write_text(tok)
        cfg = self.dir / "mcp.json"
        script = ('norm_posint() { :; }\nkill_claude_leaf() { :; }\n'
                  + self.block().replace("/tmp/mctl-events-telegram-served-exp", str(self.served)))
        env = {**os.environ, "MCTL_EVENTS_TELEGRAM_MCP_URL": "https://tg.example/mcp",
               "MCTL_EVENTS_TELEGRAM_MCP_TOKEN_FILE": str(self.seed),
               "MCTL_EVENTS_TELEGRAM_TOKEN_STATE": str(self.state),
               "MCTL_EVENTS_TELEGRAM_TOKEN_RENEW": "false", "MCTL_EVENTS_MCP_CONFIG": str(cfg)}
        proc = subprocess.run(["/bin/sh", "-e", "-c", script], capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        text = cfg.read_text()
        self.assertNotIn(tok, text)
        server = json.loads(text)["mcpServers"]["mctl-telegram"]
        self.assertEqual("https://tg.example/mcp", server["url"])
        self.assertNotIn("headers", server)
        argv = shlex.split(server["headersHelper"])
        self.assertEqual(["python3", "/opt/mctl-events/mctl_events/telegram_token.py", "header"], argv[:3])
        out = subprocess.run([sys.executable, str(TOOL), *argv[2:]], capture_output=True, text=True, timeout=30)
        self.assertEqual(0, out.returncode, out.stderr)
        self.assertEqual(f"Bearer {tok}", json.loads(out.stdout)["Authorization"])

    def test_path_with_a_space_is_refused(self) -> None:
        script = 'norm_posint() { :; }\nkill_claude_leaf() { :; }\n' + self.block()
        env = {**os.environ, "MCTL_EVENTS_TELEGRAM_MCP_URL": "https://tg.example/mcp",
               "MCTL_EVENTS_TELEGRAM_MCP_TOKEN_FILE": str(self.seed),
               "MCTL_EVENTS_TELEGRAM_TOKEN_STATE": "/tmp/a b", "MCTL_EVENTS_MCP_CONFIG": str(self.dir / "m.json")}
        self.seed.write_text(jwt(NOW))
        proc = subprocess.run(["/bin/sh", "-e", "-c", script], capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(2, proc.returncode)
        self.assertIn("may contain only", proc.stderr)

    def test_pushgateway_url_without_a_scheme_is_refused(self) -> None:
        script = 'norm_posint() { :; }\nkill_claude_leaf() { :; }\n' + self.block()
        env = {**os.environ, "MCTL_EVENTS_TELEGRAM_MCP_URL": "https://tg.example/mcp",
               "MCTL_EVENTS_TELEGRAM_MCP_TOKEN_FILE": str(self.seed),
               "MCTL_EVENTS_TELEGRAM_TOKEN_STATE": str(self.state),
               "MCTL_EVENTS_PUSHGATEWAY_URL": "pushgateway.monitoring.svc",
               "MCTL_EVENTS_MCP_CONFIG": str(self.dir / "m.json")}
        self.seed.write_text(jwt(NOW))
        proc = subprocess.run(["/bin/sh", "-e", "-c", script], capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(2, proc.returncode)
        self.assertIn("MCTL_EVENTS_PUSHGATEWAY_URL", proc.stderr)

    def test_renewal_loop_relaunches_the_session_on_recycle(self) -> None:
        # python3 is shimmed to a renew that asks for a relaunch; the loop must
        # pass the configured arguments and call kill_claude_leaf.
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        argv_file, killed = self.dir / "argv", self.dir / "killed"
        shim = bin_dir / "python3"
        # Asks for one relaunch only, and publishes argv atomically, so nothing
        # rewrites the files while the assertions read them.
        shim.write_text(f'#!/bin/sh\n[ -f {argv_file} ] && exit 0\n'
                        f'printf "%s\\n" "$@" > {argv_file}.part && mv {argv_file}.part {argv_file}\nexit 10\n')
        shim.chmod(0o755)
        script = ('norm_posint() { :; }\n'
                  f'kill_claude_leaf() {{ echo "$1" > {killed}; }}\n'
                  'DEVICE_NAME=dev-1\n' + self.block())
        env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
               "MCTL_EVENTS_TELEGRAM_MCP_URL": "https://tg.example/mcp",
               "MCTL_EVENTS_TELEGRAM_MCP_TOKEN_FILE": str(self.seed),
               "MCTL_EVENTS_TELEGRAM_TOKEN_STATE": str(self.state),
               "MCTL_EVENTS_TELEGRAM_TOKEN_CHECK_SECONDS": "1",
               "MCTL_EVENTS_PUSHGATEWAY_URL": "http://pushgateway:9091",
               "MCTL_EVENTS_MCP_CONFIG": str(self.dir / "m.json")}
        self.seed.write_text(jwt(NOW))
        # A file, not a pipe: the background loop inherits stdout and would
        # keep a pipe open for as long as it runs.
        out = self.dir / "out"
        with out.open("w") as fh:
            # Own process group, killed whatever happens below: the loop and
            # its sleep would otherwise outlive a failing test.
            sh = subprocess.Popen(["/bin/sh", "-e", "-c", script], stdout=fh, stderr=subprocess.STDOUT,
                                  env=env, start_new_session=True)
            self.addCleanup(self._kill_group, sh.pid)
            rc = sh.wait(timeout=30)
        self.assertEqual(0, rc, out.read_text())
        self.assertIn("telegram token renewal pid=", out.read_text())
        deadline = time.monotonic() + 10
        def reason() -> str:
            return killed.read_text() if killed.exists() else ""
        while "telegram token" not in reason() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIn("telegram token", reason())
        argv = argv_file.read_text().split("\n")
        self.assertEqual(["/opt/mctl-events/mctl_events/telegram_token.py", "renew"], argv[:2])
        for flag, value in (("--seed", str(self.seed)), ("--state", str(self.state)),
                            ("--mcp-url", "https://tg.example/mcp"),
                            ("--pushgateway", "http://pushgateway:9091"), ("--instance", "dev-1")):
            self.assertEqual(value, argv[argv.index(flag) + 1], flag)

    @staticmethod
    def _kill_group(pgid: int) -> None:
        try:
            os.killpg(pgid, 9)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    unittest.main()
