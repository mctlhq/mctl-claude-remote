'use strict';
const fs = require('fs');
const http = require('http');
const PORT = parseInt(process.env.PORT || '8080', 10);

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

http.createServer((req, res) => {
  if (!isClaudeRunning()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('claude process not found\n');
    return;
  }
  if (!hasOutboundTls()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('claude has no outbound TLS connections\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
}).listen(PORT, () => {
  console.log(`healthz :${PORT}`);
});
