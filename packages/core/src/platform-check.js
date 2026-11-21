// Development check, not part of the app (the desktop build leaves it out; Node only).
// Compares the window.lurkbox members the core uses with the ones documented in platform.d.ts.
// Run by packages/core/test/platform.test.mjs (npm test), or directly: node packages/core/src/platform-check.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** Member names of `interface LurkboxPlatform { ... }` in platform.d.ts text. */
export function documentedMembers(dts) {
  const start = dts.indexOf('interface LurkboxPlatform {');
  if (start < 0) throw new Error('platform.d.ts: interface LurkboxPlatform not found');
  const body = dts.slice(start, dts.indexOf('\n}', start));
  return new Set([...body.matchAll(/^ {2}(\w+)\??\s*[(:<]/gm)].map((m) => m[1]));
}

/** Removes comments (keeps strings, including URLs with "//"), so commented-out calls don't count. */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  return out;
}

/**
 * window.lurkbox members used in one source text: `window.lurkbox.x`, `window.lurkbox?.x`, aliases
 * (`const api = window.lurkbox; api.x`) and destructuring (`const { x } = window.lurkbox`).
 * Returns { used: Set, problems: string[] } (problems: computed access that can't be checked).
 */
export function usedMembers(text) {
  const src = stripComments(text);
  const used = new Set();
  const problems = [];
  const names = ['window\\.lurkbox'];
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*window\.lurkbox\b(?!\s*\??\.)/g)) names.push(`\\b${m[1]}`);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*window\.lurkbox\b(?!\s*\??\.)/g)) {
    for (const part of m[1].split(',')) { const k = part.split(':')[0].trim(); if (k) used.add(k); }
  }
  for (const name of names) {
    for (const m of src.matchAll(new RegExp(`${name}\\s*(?:\\?\\.|\\.)\\s*(\\w+)`, 'g'))) used.add(m[1]);
    if (new RegExp(`${name}\\s*(?:\\?\\.)?\\[`).test(src)) problems.push(`computed access on ${name.replace(/\\[bs.]/g, (x) => x.slice(1))}`);
  }
  return { used, problems };
}

/** Core source files that run in the page: every .js and .html under src/ except this file. */
export function coreSources(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...coreSources(p));
    else if (/\.(js|html)$/.test(e.name) && !(dir === SRC && e.name === SELF)) out.push(p);
  }
  return out.sort();
}

/** Runs the whole check. Returns { documented, used: Map<member, files[]>, undocumented, unused, problems }. */
export function checkPlatform(dir = SRC) {
  const documented = documentedMembers(fs.readFileSync(path.join(dir, 'platform.d.ts'), 'utf8'));
  const used = new Map();
  const problems = [];
  for (const file of coreSources(dir)) {
    const rel = path.relative(dir, file);
    const r = usedMembers(fs.readFileSync(file, 'utf8'));
    for (const k of r.used) used.set(k, [...(used.get(k) || []), rel]);
    for (const p of r.problems) problems.push(`${rel}: ${p}`);
  }
  const undocumented = [...used.keys()].filter((k) => !documented.has(k)).sort();
  const unused = [...documented].filter((k) => !used.has(k)).sort();
  return { documented, used, undocumented, unused, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkPlatform();
  console.log(`window.lurkbox: ${r.documented.size} documented, ${r.used.size} used by the core`);
  for (const k of r.undocumented) console.log(`  not in platform.d.ts: ${k} (${r.used.get(k).join(', ')})`);
  for (const k of r.unused) console.log(`  documented but unused: ${k}`);
  for (const p of r.problems) console.log(`  ${p}`);
  process.exitCode = r.undocumented.length || r.unused.length || r.problems.length ? 1 : 0;
}
