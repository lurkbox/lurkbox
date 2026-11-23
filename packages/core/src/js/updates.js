// Update notifications in the page: the host checks GitHub (window.lurkbox.updateState and friends, platform.d.ts
// UpdateState); this shows a one-time toast per new version and the update row of Settings → About.
import { el, button, toast } from './ui.js';
import { openModal } from './modal.js';
import { focusEl } from './focus.js';
import { state, saveSettings } from './state.js';
import { shouldNotify, updateSummary } from '../shared/updates.js';

let current = null;
const listeners = new Set();

/** Is the host's updater there? */
export function hasUpdates() { return !!(window.lurkbox && window.lurkbox.updateState); }

/** The last update state, or null. */
export function updateNow() { return current; }

function apply(st) {
  if (!st || typeof st !== 'object') return;
  current = st;
  for (const fn of listeners) { try { fn(st); } catch (e) { console.error(e); } }
  if (shouldNotify(st, state.settings.updateNotified)) {
    const v = st.latest.version;
    saveSettings({ updateNotified: v }).catch(() => {});
    toast(`Lurkbox v${v} is available. Settings → About`, 7000, 'ok update-toast');
  }
}

/** At startup: the host's current state, then every change. */
export function startUpdates() {
  if (!hasUpdates()) return;
  window.lurkbox.onUpdateState(apply);
  window.lurkbox.updateState().then(apply).catch(() => {});
}

/** The release page as a QR code and its address (the TV has no browser to open it in). */
export function showRelease(st = current) {
  const url = (st && st.latest && st.latest.url) || 'https://github.com/lurkbox/lurkbox/releases/latest';
  const qr = el('div', { class: 'signin-qr update-qr', 'aria-hidden': 'true' });
  const m = openModal({
    title: st && st.latest ? `Lurkbox v${st.latest.version}` : 'Lurkbox releases',
    class: 'update-release',
    content: el('div', { class: 'update-release-body' },
      qr,
      el('div', { class: 'update-release-text' },
        el('p', {}, 'Scan to open the release page, or open this address in a browser:'),
        el('p', { class: 'update-url' }, url),
        button('Close', () => m.close(), { class: 'primary', dataset: { key: 'update-release-close' } }))),
  });
  Promise.resolve(window.lurkbox.qrSvg(url)).then((svg) => { if (typeof svg === 'string' && svg.startsWith('<svg')) qr.innerHTML = svg; }).catch(() => {});
  return m;
}

const LABELS = { check: 'Check now', download: 'Download', release: 'Release page' };

async function act(action) {
  const api = window.lurkbox;
  if (action === 'check') apply(await api.updateCheck().catch(() => null));
  else if (action === 'download') apply(await api.updateDownload().catch(() => null));
  else if (action === 'release') showRelease();
  else if (action === 'install') {
    const r = await api.updateInstall().catch(() => ({ ok: false, reason: 'failed' }));
    if (r && r.ok && current && current.install === 'appimage') toast('Restarting Lurkbox…', 4000);
    else if (r && !r.ok && r.reason !== 'permission') toast(`Couldn't start the update (${r.reason || 'error'})`, 5000, 'warn');
  }
}

/**
 * Settings → About's update row: the state's text and its buttons, updated in place as the state changes (a focused
 * button that goes away hands the focus to the row's first new one).
 */
export function updateRow() {
  const text = el('div', { class: 'setting-value update-status', role: 'status' });
  const buttons = el('div', { class: 'row update-actions' });
  const box = el('div', { class: 'update-row' }, text, buttons);
  let shown = '';
  let parked = null;
  const render = (st) => {
    if (!box.isConnected && shown) { listeners.delete(render); return; }
    const s = updateSummary(st);
    text.textContent = s.text;
    const installLabel = st && st.install === 'apk' ? 'Install' : 'Restart to update';
    const key = s.actions.join(',');
    if (key === shown) return;
    // The focus follows the row: on its buttons, or parked on the toggle above while there are none (downloading).
    const hadFocus = buttons.contains(document.activeElement) || (parked && document.activeElement === parked);
    parked = null;
    shown = key || '-';
    buttons.replaceChildren(...s.actions.map((a, i) => button(a === 'install' ? installLabel : LABELS[a], () => act(a), { class: i === 0 && a !== 'check' ? 'primary' : '', dataset: { setting: `update-${a}` } })));
    if (hadFocus) {
      const first = buttons.querySelector('button');
      const settings = box.closest('.settings');
      if (first) focusEl(first, { instant: true });
      else if (settings && (parked = settings.querySelector('[data-setting="checkUpdates"]'))) focusEl(parked, { instant: true });
    }
  };
  listeners.add(render);
  render(current);
  if (!current && hasUpdates()) window.lurkbox.updateState().then(apply).catch(() => {});
  return box;
}
