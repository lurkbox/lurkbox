// Sign-in. The main path is one sign-in on the TV (twitch.tv login, then Authorize, in the in-app window), which
// covers both the Lurkbox API token and the player's web session. The phone path (code + QR) is the fallback;
// it leaves the player signed out, so it offers the TV login for the player afterwards. A host without the TV
// sign-in (window.lurkbox.tvSignIn, e.g. Android for now) uses the phone path everywhere.
import { el, button, toast } from './ui.js';
import { openModal, confirmDialog } from './modal.js';
import { state } from './state.js';
import { mascotEl } from './mascot.js';
import { offerPlayerSignIn } from './player-login.js';

let active = null;
let tvBusy = false;

/**
 * One sign-in on the TV. opts: { add, accountId, onSuccess }.
 * Resolves with the main process result ({ ok, login } or { ok: false, cancelled | error, message }).
 */
export async function tvSignIn({ add = false, accountId = null, onSuccess } = {}) {
  if (tvBusy) return null;
  if (!window.lurkbox.tvSignIn) { openSignIn({ add, onSuccess }); return null; }
  if (!state.auth.hasClientId) {
    toast('Set a Client ID in Settings first', 4000, 'warn');
    return null;
  }
  tvBusy = true;
  let r;
  try {
    toast('Opening twitch.tv sign-in…', 2500);
    r = await window.lurkbox.tvSignIn({ add, accountId });
  } catch (e) {
    r = { ok: false, error: 'failed', message: e.message };
  } finally {
    tvBusy = false;
  }
  if (r.ok) {
    toast(`Signed in as ${r.login}`, 4000, 'ok');
    if (onSuccess) onSuccess();
  } else if (r.error === 'mismatch') {
    confirmDialog({
      title: 'Two different accounts',
      message: r.message,
      yes: 'Try again',
      no: 'Cancel',
      onYes: () => tvSignIn({ add, accountId, onSuccess }),
    });
  } else if (r.cancelled) {
    toast('Sign-in cancelled', 2500);
  } else if (r.error !== 'busy') {
    const why = r.error === 'denied' ? 'Authorization was declined.' : r.error === 'expired' ? 'The sign-in timed out.' : (r.message || 'Something went wrong.');
    confirmDialog({
      title: 'Sign-in didn\'t finish',
      message: why,
      yes: 'Try again',
      no: 'Use your phone instead',
      onYes: () => tvSignIn({ add, accountId, onSuccess }),
      onNo: () => openSignIn({ add, onSuccess }),
    });
  }
  return r;
}

/** The phone flow: a code and QR code for twitch.tv/activate on another device. */
export async function openSignIn({ onSuccess, add = false } = {}) {
  if (active) return active;
  if (!state.auth.hasClientId) {
    toast('Set a Client ID in Settings first', 4000, 'warn');
    return null;
  }
  const status = el('div', { class: 'signin-status' }, 'Contacting Twitch…');
  const codeEl = el('div', { class: 'signin-code' }, '········');
  const urlEl = el('div', { class: 'signin-url' }, 'twitch.tv/activate');
  const qrEl = el('div', { class: 'signin-qr' });
  const content = el('div', { class: 'signin' },
    el('div', { class: 'signin-text' },
      mascotEl('signin-mascot'),
      add ? el('p', { class: 'signin-hint' }, 'On your phone, make sure you\'re signed in to the account you want to add at twitch.tv (switch accounts there first), then enter the code.') : null,
      el('p', { class: 'signin-step' }, 'On your phone or computer, go to'),
      urlEl,
      el('p', { class: 'signin-step' }, 'and enter this code'),
      codeEl,
      status,
      el('div', { class: 'row' },
        button('Get a new code', () => start(), { class: 'signin-retry' }),
        button('Cancel', () => m.close(), { class: 'signin-cancel' }))),
    qrEl);

  const unsub = window.lurkbox.onAuthEvent((ev) => {
    if (ev.status === 'success') {
      toast(`Signed in as ${ev.user ? ev.user.login : 'Twitch user'}`, 4000, 'ok');
      m.close();
      if (onSuccess) onSuccess();
      if (window.lurkbox.playerSessionLogin) window.lurkbox.playerSessionStatus().then((p) => { if (!p.signedIn) offerPlayerSignIn(); }).catch(() => {});
    } else if (ev.status === 'expired') {
      status.textContent = 'The code expired. Select "Get a new code".';
    } else if (ev.status === 'denied') {
      status.textContent = 'Sign-in was declined on Twitch.';
    }
  });

  const m = openModal({
    title: add ? 'Add a Twitch account' : 'Sign in to Twitch',
    class: 'signin-modal',
    content,
    focus: '.signin-cancel',
    onClose() {
      unsub();
      active = null;
      if (!state.auth.signedIn) window.lurkbox.authCancel();
    },
  });
  active = m;

  async function start() {
    status.textContent = 'Contacting Twitch…';
    const r = await window.lurkbox.authStart();
    if (m.closed) return;
    if (!r.ok) {
      status.textContent = r.error;
      return;
    }
    const f = r.flow;
    codeEl.textContent = f.userCode;
    let shown = 'twitch.tv/activate';
    try { const u = new URL(f.verificationUri); shown = (u.host.replace(/^www\./, '') + u.pathname); } catch { /* keep default */ }
    urlEl.textContent = shown;
    qrEl.innerHTML = await window.lurkbox.qrSvg(f.verificationUri); // SVG generated locally from Twitch's URL
    qrEl.append(el('div', { class: 'signin-qr-caption' }, 'Or scan to open the page with the code filled in'));
    status.textContent = 'Waiting for you to approve on Twitch…';
  }
  start();
  return m;
}
