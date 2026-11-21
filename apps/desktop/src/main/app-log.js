'use strict';
// lurkbox.log in userData (readable over SSH). Size-based rotation: when the file would pass maxBytes it becomes
// lurkbox.log.1 (replacing the previous one) and a new lurkbox.log starts. Never log tokens.
const fs = require('fs');

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Returns log(line): appends "<ISO time> <line>" to file, rotating at maxBytes. Never throws. */
function createAppLog(file, { maxBytes = LOG_MAX_BYTES, now = () => new Date() } = {}) {
  let size = null;
  return function log(line) {
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
  };
}

module.exports = { createAppLog, LOG_MAX_BYTES };
