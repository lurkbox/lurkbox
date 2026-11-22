// Placeholder Android window.lurkbox (scaffold only): settings in memory, nothing signed in. The real Capacitor
// implementation replaces this file (docs/android.md, step 2).
import { DEFAULT_SETTINGS, sanitizeSettings } from '@lurkbox/core/src/shared/settings.js';

let settings = { ...DEFAULT_SETTINGS };
const noop = () => () => {};
const auth = { hasClientId: true, signedIn: false, needsReauth: false, missingScopes: [], user: null, active: null, accounts: [], deviceFlow: null };
window.lurkbox = {
  appInfo: async () => ({ windowed: false, gamescope: false, startChannel: null, startVod: null, version: __LURKBOX_VERSION__, defaults: DEFAULT_SETTINGS }),
  quit: async () => {},
  onWindowFocus: noop,
  qrSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  getSettings: async () => settings,
  setSettings: async (patch) => { settings = { ...settings, ...sanitizeSettings(patch || {}) }; return settings; },
  onSettingsChanged: noop,
  authState: async () => auth,
  authStart: async () => ({ ok: false, error: 'Sign-in is not ready on Android yet.' }),
  authCancel: async () => {},
  signOut: async () => null,
  accountsStatus: async () => [],
  switchAccount: async () => false,
  removeAccount: async () => null,
  onAuthState: noop,
  onAuthEvent: noop,
  helix: async () => ({ ok: false, status: 401, error: 'NOT_SIGNED_IN', data: null, resetAt: null }),
  playerSessionStatus: async () => ({ signedIn: false, login: null, mismatch: null }),
  playerSessionSignOut: async () => ({ signedIn: false, login: null, mismatch: null }),
  dismissPlayerGate: async () => '',
  directMaster: async () => ({ ok: false, reason: 'unavailable' }),
  pointsOpenPanel: async () => ({ ok: false, reason: 'unavailable' }),
  pointsPad: async () => null,
  pointsClosePanel: async () => false,
  onPointsEvent: noop,
  dropsOpen: async () => ({ ok: false, reason: 'unavailable' }),
  dropsPad: async () => 'close',
  dropsClose: async () => false,
  openReady: async () => null,
  onOpenChannel: noop,
  steamArtApply: async () => ({ ok: false, error: 'unavailable' }),
  steamArtRestore: async () => ({ ok: false, error: 'unavailable' }),
  chatExtensionsUpdate: async () => [],
  tvSignIn: async () => ({ ok: false, error: 'unavailable', message: 'Not available on Android yet.' }),
  playerSessionLogin: async () => ({ ok: false, signedIn: false, login: null, mismatch: null }),
};
