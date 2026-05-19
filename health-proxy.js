'use strict';
const http = require('http');
const net  = require('net');

const CLAUDE_PORT = parseInt(process.env.CLAUDE_PORT || '3000', 10);
const PROXY_PORT  = parseInt(process.env.PORT        || '8080', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  // Proxy plain HTTP to claude
  const opts = {
    host: 'localhost',
    port: CLAUDE_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const proxy = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  proxy.on('error', (err) => {
    console.error('proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
});

// WebSocket upgrade — raw TCP tunnel to claude
server.on('upgrade', (req, socket, head) => {
  const target = net.connect(CLAUDE_PORT, 'localhost', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      lines.push(`${k}: ${v}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', (err) => {
    console.error('ws tunnel error:', err.message);
    socket.destroy();
  });
  socket.on('error', () => target.destroy());
});

server.listen(PROXY_PORT, () => {
  console.log(`health-proxy :${PROXY_PORT} → claude :${CLAUDE_PORT}`);
});
