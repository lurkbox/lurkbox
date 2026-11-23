'use strict';
// lurkbox.log in userData (readable over SSH). Size-based rotation: when the file would pass maxBytes it becomes
// lurkbox.log.1 (replacing the previous one) and a new lurkbox.log starts. Never log tokens.
const fs = require('fs');

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Returns log(line): appends "<ISO time> <line>" to file, rotating at maxBytes. Never throws. */
function createAppLog(file, { maxBytes = LOG_MAX_BYTES, now = () => new Date() } = {}) {
  let size = null;
  function log(line) {
    try {
      const text = `${now().toISOString()} ${line}\n`;
      if (size === null) { try { size = fs.statSync(file).size; } catch { size = 0; } }
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
        try { fs.renameSync(file, `${file}.1`); } catch { /* gone already */ }
        size = 0;
      }
      fs.appendFileSync(file, text, { mode: 0o600 });
      size += Buffer.byteLength(text);
    } catch { size = null; /* logging must never break the app */ }
  }
  /** The file was rewritten elsewhere (stripLogLines): read its size again before the next line. */
  log.resetSize = () => { size = null; };
  return log;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sign-out: removes every line that mentions one of the words (an account's user id and login, matched as whole words,
 * case-insensitive) from the log and its rotated copy, and notes that once. Returns the number of lines removed.
 */
function stripLogLines(file, words, { now = () => new Date() } = {}) {
  const list = (words || []).map((w) => String(w || '').trim()).filter((w) => w.length >= 2);
  if (!list.length) return 0;
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${list.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'i');
  let removed = 0;
  for (const f of [file, `${file}.1`]) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const kept = lines.filter((l) => !re.test(l));
    if (kept.length === lines.length) continue;
    removed += lines.length - kept.length;
    let out = kept.join('\n');
    if (f === file) out += `${out && !out.endsWith('\n') ? '\n' : ''}${now().toISOString()} [accounts] log lines of a signed-out account removed\n`;
    fs.writeFileSync(f, out, { mode: 0o600 });
  }
  return removed;
}

module.exports = { createAppLog, stripLogLines, LOG_MAX_BYTES };
