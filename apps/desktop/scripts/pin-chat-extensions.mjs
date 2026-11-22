#!/usr/bin/env node
// Pins the chat extensions (src/main/chat-extensions.lock.json) to a release: finds each project's current stable
// release on GitHub the way chat-extensions.js describes (EXTENSIONS), downloads the file, and writes its version, URL
// and SHA-256. The app installs only what this file names, so moving to a newer release is a reviewed change to it.
//   node apps/desktop/scripts/pin-chat-extensions.mjs            all extensions
//   node apps/desktop/scripts/pin-chat-extensions.mjs 7tv bttv   only these
// Set GITHUB_TOKEN to avoid the API's anonymous rate limit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EXTENSIONS, LOCK_FILE } = require('../src/main/chat-extensions.js');

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Lurkbox pin script', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXTENSIONS);
const lock = fs.existsSync(LOCK_FILE) ? JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) : {};

for (const key of keys) {
  const def = EXTENSIONS[key];
  if (!def) throw new Error(`unknown extension ${key}`);
  const r = await fetch(`https://api.github.com/repos/${def.repo}/releases?per_page=20`, { headers });
  if (!r.ok) throw new Error(`${key}: GitHub ${r.status}`);
  const rel = def.pick(await r.json());
  if (!rel) throw new Error(`${key}: no release found`);
  const asset = (rel.assets || []).find((a) => def.asset.test(a.name));
  if (!asset) throw new Error(`${key}: release ${rel.tag_name} has no ${def.asset} asset`);
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!dl.ok) throw new Error(`${key}: download ${dl.status}`);
  const sha256 = crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex');
  if (asset.digest && asset.digest !== `sha256:${sha256}`) throw new Error(`${key}: the download does not match GitHub's digest`);
  const next = { version: def.version(rel), url: asset.browser_download_url, sha256 };
  const prev = lock[key];
  lock[key] = next;
  console.log(`${key}: ${prev && prev.version === next.version && prev.sha256 === sha256 ? 'unchanged' : `${prev ? prev.version : 'none'} -> ${next.version}`} (${sha256})`);
}
fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
