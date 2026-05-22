'use strict';
const fs = require('fs');
const http = require('http');
const PORT = parseInt(process.env.PORT || '8080', 10);

// Grace window: tolerate TLS connection drops shorter than this many ms.
// The relay WebSocket briefly loses ESTABLISHED state during reconnects
// triggered by large payloads (e.g. image uploads from the mobile app).
const TLS_GRACE_MS = parseInt(process.env.TLS_GRACE_MS || '60000', 10);

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

// Timestamp of the last probe that observed an ESTABLISHED TLS connection.
// Starts at 0 so a brand-new container that has never had a connection fails
// immediately (the startup probe covers the initial connect window).
let lastGoodTls = 0;

http.createServer((req, res) => {
  if (!isClaudeRunning()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('claude process not found\n');
    return;
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
    res.end(`OK (TLS grace: ${Math.round(elapsed / 1000)}s ago)\n`);
    return;
  }

  res.writeHead(503, { 'Content-Type': 'text/plain' });
  res.end('claude has no outbound TLS connections\n');
}).listen(PORT, () => {
  console.log(`healthz :${PORT}`);
});
