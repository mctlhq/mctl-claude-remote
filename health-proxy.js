'use strict';
const http = require('http');
const PORT = parseInt(process.env.PORT || '8080', 10);

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`healthz :${PORT}`);
});
