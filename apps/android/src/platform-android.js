// Entry point bundled into www/platform-android.js (scripts/build-web.mjs) and loaded before the core's js/main.js:
// the Android window.lurkbox, wired to Capacitor's native plugins and the app's own LurkboxNative plugin.
import { CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import qrcode from 'qrcode-generator';
import { makeNativeFetch } from './http.js';
import { createPlatform } from './platform.js';
import { installBackButton } from './input.js';
import { installKeepScreenOn } from './playback.js';

const Native = registerPlugin('LurkboxNative');

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}

window.lurkbox = createPlatform({
  fetch: makeNativeFetch(CapacitorHttp),
  prefs: Preferences,
  app: App,
  native: Native,
  qrSvg,
  version: __LURKBOX_VERSION__, // eslint-disable-line no-undef
});
installBackButton(App, window);
installKeepScreenOn(document, Native);
