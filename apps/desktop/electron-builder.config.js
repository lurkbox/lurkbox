'use strict';
// electron-builder configuration for the desktop app (run from apps/desktop; `npm run dist` at the repo root).
// The renderer comes from the @lurkbox/core workspace package (copied into app.asar/node_modules/@lurkbox/core);
// the runtime assets come from the repo's top-level assets/ folder.
module.exports = {
  appId: 'io.github.lurkbox.Lurkbox',
  productName: 'Lurkbox', // also keeps userData at ~/.config/Lurkbox
  artifactName: 'Lurkbox-${version}-${arch}.${ext}',
  // npm workspaces hoist electron to the repo root and package.json keeps a range, so pin the installed version.
  electronVersion: require('electron/package.json').version,
  files: [
    'src/**/*',
    'package.json',
    '!node_modules/@lurkbox/core/src/platform-check.js', // dev check (Node only), not part of the app
    { from: '../../assets', to: 'assets', filter: ['icons/**/*', 'steam/**/*', 'src/wordmark.json'] },
  ],
  directories: {
    output: '../../dist', // dist/Lurkbox-<version>-x86_64.AppImage at the repo root
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'AudioVideo',
    executableName: 'lurkbox',
    icon: '../../assets/icons',
    syncDesktopName: true,
  },
};
