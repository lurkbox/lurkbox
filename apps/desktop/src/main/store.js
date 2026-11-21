'use strict';
// Small JSON file store kept in app.getPath('userData'). Never in the repo.
// The settings schema (defaults, themes, validation) is shared with other platforms and lives in @lurkbox/core.
const fs = require('fs');
const path = require('path');
const { THEMES, DEFAULT_SETTINGS, sanitizeSettings } = require('@lurkbox/core/src/shared/settings.js');

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults || {};
    this.data = { ...this.defaults };
    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = { ...this.defaults, ...JSON.parse(raw) };
      // Migration: the old 'auto' screen margin (2.5% under Gamescope) caused the embed to pause.
      if (this.data.screenMargin === 'auto') this.data.screenMargin = 0;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[store] could not read ${file}: ${e.message}`);
    }
  }
  get() { return { ...this.data }; }
  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.get();
  }
  replace(obj) {
    this.data = { ...this.defaults, ...obj };
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonFile, DEFAULT_SETTINGS, THEMES, sanitizeSettings };
