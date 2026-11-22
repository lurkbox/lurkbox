import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { startServer } = require('../../src/main/server.js');

let srv;
let root;
before(async () => {
  const base = tmpDir();
  root = path.join(base, 'www');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'top secret');
  srv = await startServer(root);
});
after(() => srv.close());

function get(rawPath, host = `localhost:${srv.port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: rawPath, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'], nosniff: res.headers['x-content-type-options'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves index.html on localhost', async () => {
  assert.match(srv.url, /^http:\/\/localhost:\d+\/$/);
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.equal(r.body, '<h1>ok</h1>');
  assert.match(r.type, /text\/html/);
  assert.equal(r.nosniff, 'nosniff');
  assert.equal((await get('/missing.js')).nosniff, 'nosniff');
});

test('blocks path traversal', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.body.includes('top secret'), p);
  }
});

test('rejects a foreign Host header (DNS rebinding)', async () => {
  const r = await get('/', 'evil.example.com');
  assert.equal(r.status, 403);
  assert.equal((await get('/', `127.0.0.1:${srv.port}`)).status, 200);
});
