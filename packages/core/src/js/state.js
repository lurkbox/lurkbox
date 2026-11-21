import { sanitizeCustom, deriveTokens, applyTokens } from './theme-custom.js';
import { twitchChatZoom, twitchChatPanelWidth } from '../shared/tv-zoom.js';
import { sanitizeSettings } from '../shared/settings.js';

// Shared app state: settings, auth and app info, with change listeners.
const listeners = new Set();

export const state = {
  info: { windowed: false, startChannel: null, version: '', defaults: {} },
  settings: {},
  auth: { hasClientId: false, signedIn: false, user: null, deviceFlow: null },
};

export function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(what) {
  for (const fn of listeners) {
    try { fn(what); } catch (e) { console.error(e); }
  }
}

export async function initState() {
  const api = window.lurkbox;
  [state.info, state.settings, state.auth] = await Promise.all([api.appInfo(), api.getSettings(), api.authState()]);
  api.onSettingsChanged((s) => { state.settings = withPending(s); emit('settings'); });
  api.onAuthState((a) => {
    const was = state.auth.signedIn;
    const wasActive = state.auth.active;
    state.auth = a;
    if (a.signedIn && was && wasActive !== a.active) emit('account');
    else emit(was !== a.signedIn ? 'signin' : 'auth');
  });
}

// Live previews (sliders): applied to state.settings at once, saved to the host after a short pause. Until then the
// pending values win over what the host echoes back, so a slider never jumps back while it moves.
let pending = {};
let pendingTimer = null;
const withPending = (s) => (Object.keys(pending).length ? { ...s, ...pending } : s);

/**
 * Changes settings right away (every listener sees them, e.g. the chat pop-over and Settings → Chat) and saves them
 * `delay` ms after the last change. One settings source: the same keys and the same save path as saveSettings().
 */
export function previewSettings(patch, delay = 250) {
  const clean = sanitizeSettings(patch || {});
  if (!Object.keys(clean).length) return state.settings;
  Object.assign(pending, clean);
  state.settings = { ...state.settings, ...clean };
  emit('settings');
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { flushSettings().catch((e) => console.warn('[settings] save failed', e.message)); }, delay);
  return state.settings;
}

/** Saves the pending previews now (returns the saved settings, or the current ones when nothing was pending). */
export async function flushSettings() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  if (!Object.keys(pending).length) return state.settings;
  const patch = pending;
  pending = {};
  return saveSettings(patch);
}

export async function saveSettings(patch) {
  for (const k of Object.keys(patch || {})) if (patch !== pending) delete pending[k]; // an explicit save wins
  state.settings = withPending(await window.lurkbox.setSettings(patch));
  state.auth = await window.lurkbox.authState();
  emit('settings');
  return state.settings;
}

export const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'chunked', label: 'Source' },
  { value: '1080p60', label: '1080p60' },
  { value: '720p60', label: '720p60' },
  { value: '720p30', label: '720p' },
  { value: '480p30', label: '480p' },
  { value: '360p30', label: '360p' },
  { value: '160p30', label: '160p' },
];
export const THEMES = [
  { value: 'lurkbox', label: 'Lurkbox' },
  { value: 'game-mode', label: 'Game Mode' },
  { value: 'classic-purple', label: 'Classic Purple' },
  { value: 'oled', label: 'OLED' },
  { value: 'daylight', label: 'Daylight' },
  { value: 'high-contrast', label: 'High Contrast' },
  { value: 'custom', label: 'Custom' },
];

/**
 * Applies a theme to the document (does not save it). For 'custom', `colors`
 * overrides the saved custom colours (live editing).
 */
export function applyTheme(name, colors) {
  const known = THEMES.some((t) => t.value === name) ? name : 'lurkbox';
  if (known === 'custom') {
    const c = colors || sanitizeCustom(state.settings.customTheme).colors;
    applyTokens(deriveTokens(c));
  } else {
    if (document.documentElement.dataset.theme === known && !document.documentElement.style.length) return;
    applyTokens(null);
  }
  document.documentElement.dataset.theme = known;
  window.dispatchEvent(new CustomEvent('themechange', { detail: known }));
}

/** Applies display settings: UI scale and TV overscan margin. */
export function applyDisplay() {
  const s = state.settings;
  const margin = Number(s.screenMargin) || 0;
  const root = document.documentElement.style;
  root.setProperty('--ui-scale', String((Number(s.uiScale) || 100) / 100));
  root.setProperty('--screen-margin', `${margin}vmin`);
  // Twitch chat style: the host zooms Twitch's chat frame for the TV; the panel widens so the chat keeps
  // ~340 CSS px of layout width (capped at 45% of the window), and the video shrinks beside it.
  const zoom = twitchChatZoom(s, window.screen && window.screen.height);
  root.setProperty('--tchat-zoom', String(zoom));
  root.setProperty('--tchat-w', `${twitchChatPanelWidth(zoom, window.innerWidth)}px`);
}

export const SCREEN_MARGINS = [
  { value: 0, label: 'None' }, { value: 2.5, label: '2.5%' }, { value: 5, label: '5%' },
];
export const UI_SCALES = [90, 100, 110, 125, 150].map((v) => ({ value: v, label: `${v}%` }));

export const RAID_DELAYS = [0, 3, 5, 10, 15, 20, 30, 60];
