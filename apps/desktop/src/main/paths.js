'use strict';
// Where the desktop app finds the shared core (the renderer) and the repo's assets.
// - core: the @lurkbox/core workspace package. In development node_modules/@lurkbox/core links to
//   packages/core; electron-builder copies it into app.asar/node_modules/@lurkbox/core.
// - assets: electron-builder copies the runtime assets to app.asar/assets; in development they are
//   the repo's top-level assets/ folder.
const fs = require('fs');
const path = require('path');

const CORE_DIR = path.dirname(require.resolve('@lurkbox/core/package.json'));
const WEB_ROOT = path.join(CORE_DIR, 'src');

const ASSETS_DIR = [
  path.join(__dirname, '..', '..', 'assets'), // packaged: app.asar/assets
  path.join(__dirname, '..', '..', '..', '..', 'assets'), // development: <repo>/assets
].find((d) => fs.existsSync(path.join(d, 'icons'))) || path.join(__dirname, '..', '..', 'assets');

const HLS_JS = require.resolve('hls.js/dist/hls.min.js', { paths: [CORE_DIR] });

module.exports = { CORE_DIR, WEB_ROOT, ASSETS_DIR, HLS_JS };
