'use strict';
// Tiny static file server for the renderer. The Twitch embed refuses to run
// under file:// because it needs a `parent` domain that matches the embedding
// page, so the UI is served from http://localhost:<random port>/ and the
// embed is created with parent: ['localhost'].
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function handler(root, extra = {}) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    // Only answer requests addressed to the loopback host names we serve.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = extra[urlPath] || path.normalize(path.join(root, urlPath));
    if (!extra[urlPath] && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

// Starts the server on 127.0.0.1 with a random free port, and also on ::1 with
// the same port when possible, since Chromium may resolve "localhost" to either.
async function startServer(root, extra = {}) {
  root = path.resolve(root);
  const v4 = http.createServer(handler(root, extra));
  const port = await listen(v4, 0, '127.0.0.1');
  const servers = [v4];
  try {
    const v6 = http.createServer(handler(root, extra));
    await listen(v6, port, '::1');
    servers.push(v6);
  } catch {
    // IPv6 loopback unavailable; IPv4 is enough.
  }
  return { port, url: `http://localhost:${port}/`, close: () => servers.forEach((s) => s.close()) };
}

module.exports = { startServer };
