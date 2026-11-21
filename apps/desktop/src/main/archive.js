'use strict';
// Minimal, dependency-free extraction of .zip (stored/deflate) and .tar.gz archives, for downloaded browser
// extensions. Every entry path is checked so nothing can be written outside the target folder (zip-slip).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Normalises an archive entry name; returns null for anything unsafe (absolute, '..', drive letters). */
function safeEntry(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\0')) return null;
  const parts = n.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function writeEntry(root, name, data) {
  const rel = safeEntry(name);
  if (rel === null) throw new Error(`unsafe path in archive: ${name}`);
  if (!rel) return;
  const out = path.join(root, rel);
  if (!out.startsWith(path.resolve(root) + path.sep)) throw new Error(`unsafe path in archive: ${name}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

/** Reads a zip (or a CRX3, which is a zip with a header) from a Buffer → [{ name, data }]. */
function readZip(buf) {
  let base = 0;
  if (buf.length > 16 && buf.toString('latin1', 0, 4) === 'Cr24') base = 12 + buf.readUInt32LE(8); // CRX3 header
  const zip = buf.subarray(base);
  // End of central directory: last 22..65557 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    out.push({ name, data });
  }
  return out;
}

/** Reads a .tar.gz from a Buffer → [{ name, data }] (regular files only). */
function readTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = [];
  let p = 0;
  let longName = null;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '\0') out.push({ name, data: Buffer.from(data) });
  }
  return out;
}

/** Extracts entries into `root`. If every entry shares one top folder that holds manifest.json, it is stripped. */
function extractTo(entries, root) {
  const names = entries.map((e) => safeEntry(e.name) || '');
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && names.some((n) => n.split('/').length === 2 && n.endsWith('/manifest.json'));
  fs.mkdirSync(root, { recursive: true });
  for (const e of entries) writeEntry(root, strip ? e.name.replace(/^[^/]+\//, '') : e.name, e.data);
}

module.exports = { readZip, readTarGz, extractTo, safeEntry };
