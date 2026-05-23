'use strict';
const fs = require('fs');
const http = require('http');
const PORT = parseInt(process.env.PORT || '8080', 10);

// Grace window: tolerate TLS connection drops shorter than this many ms.
// The relay WebSocket briefly loses ESTABLISHED state during reconnects
// triggered by large payloads (e.g. image uploads from the mobile app).
const TLS_GRACE_MS = parseInt(process.env.TLS_GRACE_MS || '60000', 10);

// Wedge detector: if relay data sits UNREAD in a socket's receive queue for
// this long, the claude event loop is stalled (not draining I/O) — the failure
// mode behind "Remote Control disconnected" while the process stays alive. We
// fail the probe so kubelet restarts the pod (0.5.0+ then resumes the session).
// This is idle-safe: a healthy device, idle or busy, drains rx instantly
// (rx_queue≈0); only a blocked loop lets bytes pile up. Must exceed the time it
// takes a healthy loop to drain a large burst, so it never trips on a busy
// device — pair it with the probe failureThreshold for a sustained-only restart.
const RELAY_STALL_MS = parseInt(process.env.RELAY_STALL_MS || '120000', 10);

// Returns true if any process has "remote-control" in its cmdline.
function isClaudeRunning() {
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes('remote-control')) return true;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

// Returns true if there is at least one ESTABLISHED outbound connection to
// port 443 (Anthropic relay WebSocket). Parses /proc/net/tcp6 and /proc/net/tcp.
// State 01 = ESTABLISHED in Linux TCP state table.
function hasOutboundTls() {
  for (const f of ['/proc/net/tcp6', '/proc/net/tcp']) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').slice(1); // skip header
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        if (cols[3] !== '01') continue;
        // cols[2] is remote_address "HEXIP:HEXPORT"; port is after the colon
        const port = parseInt((cols[2].split(':')[1] || ''), 16);
        if (port === 443) return true;
      }
    } catch (_) {}
  }
  return false;
}

// Largest receive-queue backlog (bytes) across ESTABLISHED outbound :443
// sockets. Healthy sockets drain to ~0 between reads; a sustained positive
// value means the owning process is not reading, i.e. its event loop is wedged.
// /proc/net/tcp column 5 is "tx_queue:rx_queue" in hex; port 443 = hex 01BB.
function relayRxBacklog() {
  let max = 0;
  for (const f of ['/proc/net/tcp6', '/proc/net/tcp']) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (cols[3] !== '01') continue;
        if ((cols[2].split(':')[1] || '').toUpperCase() !== '01BB') continue;
        const rxq = parseInt((cols[4].split(':')[1] || '0'), 16);
        if (Number.isFinite(rxq) && rxq > max) max = rxq;
      }
    } catch (_) {}
  }
  return max;
}

// Timestamp of the last probe that observed an ESTABLISHED TLS connection.
// Starts at 0 so a brand-new container that has never had a connection fails
// immediately (the startup probe covers the initial connect window).
let lastGoodTls = 0;
// Timestamp when a relay rx backlog was first observed (0 = none). Reset to 0
// the moment the queue drains, so only a *sustained* stall fails the probe.
let backlogSince = 0;

http.createServer((req, res) => {
  if (!isClaudeRunning()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('claude process not found\n');
    return;
  }

  // Wedge check runs before the TLS check: a stalled session still holds an
  // ESTABLISHED :443 socket, so hasOutboundTls() alone would report it healthy.
  const backlog = relayRxBacklog();
  if (backlog > 0) {
    if (backlogSince === 0) backlogSince = Date.now();
    const stalled = Date.now() - backlogSince;
    if (stalled >= RELAY_STALL_MS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`relay rx backlog ${backlog}B unread for ${Math.round(stalled / 1000)}s — event loop wedged\n`);
      return;
    }
  } else {
    backlogSince = 0;
  }

  if (hasOutboundTls()) {
    lastGoodTls = Date.now();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }

  // No live connection right now — but if we had one recently, stay healthy.
  // This prevents the liveness probe from killing the container during a
  // transient WebSocket reconnect (e.g. after sending a large image payload).
  const elapsed = Date.now() - lastGoodTls;
  if (lastGoodTls > 0 && elapsed < TLS_GRACE_MS) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK (TLS grace: ${Math.round((TLS_GRACE_MS - elapsed) / 1000)}s remaining)\n`);
    return;
  }

  res.writeHead(503, { 'Content-Type': 'text/plain' });
  res.end('claude has no outbound TLS connections\n');
}).listen(PORT, () => {
  console.log(`healthz :${PORT}`);
});
