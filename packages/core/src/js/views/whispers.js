// The Whispers section: a conversation per person (newest first, an unread dot), "New whisper" (a user by login,
// Helix /users), and a thread view with the chat's composer (Steam's keyboard, the built-in one, or the system one on
// touch). The data and sending live in ../whispers.js.
import { el, button, toast } from '../ui.js';
import { state, onAccountRemoved } from '../state.js';
import { whispers } from '../whispers.js';
import { usersByIds } from '../api.js';
import { avatar } from '../accounts.js';
import { focusEl } from '../focus.js';
import { focusKey } from '../focus-keep.js';
import { Composer } from '../chat-composer.js';
import { promptText } from '../text-entry.js';
import { confirmDialog } from '../modal.js';
import { tvSignIn } from '../auth.js';
import { hint, UP, DOWN } from '../input.js';

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const pics = new Map(); // user id → profile_image_url (this session)
onAccountRemoved(() => pics.clear());

/** "now", "5m", "3h", "2d", else the date. */
export function whisperTime(at, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const peerAvatar = (t, cls = 'acct-avatar') => avatar({ display_name: t.name, login: t.login, profile_image_url: pics.get(t.id) || '' }, cls);

/** Fetches the profile pictures not known yet; resolves true when there are new ones. */
async function loadPictures(threads) {
  const ids = threads.map((t) => t.id).filter((id) => !pics.has(id));
  if (!ids.length) return false;
  try {
    for (const u of (await usersByIds(ids)).values()) pics.set(String(u.id), u.profile_image_url || '');
  } catch { return false; }
  for (const id of ids) if (!pics.has(id)) pics.set(id, '');
  return true;
}

/** Signed out, no scope, or a host without storage: a message (and a button) instead of the list. */
function blockedState(svc, nav) {
  if (!svc.available) return el('div', { class: 'empty' }, el('p', {}, 'Whispers aren\'t available on this device yet.'));
  const auth = svc.authState();
  if (auth === 'ok') return null;
  if (auth === 'reauth') {
    return el('div', { class: 'empty whispers-reauth' },
      el('p', {}, 'Lurkbox needs a fresh sign-in for whispers on this account (Twitch\'s "manage whispers" permission is missing).'),
      button('Sign in again', () => tvSignIn({ accountId: state.auth.active }), { class: 'primary' }));
  }
  return el('div', { class: 'empty' }, el('p', {}, 'Sign in to read and send whispers.'), button('Sign in', () => nav.signIn(), { class: 'primary' }));
}

/** Not signed in or the scope is missing: offer the sign-in (again). */
export function promptWhisperSignIn(auth) {
  const again = auth === 'reauth';
  confirmDialog({
    title: again ? 'Sign in again for whispers' : 'Sign in for whispers',
    message: again ? 'Lurkbox needs a fresh sign-in to send whispers for this account (Twitch\'s "manage whispers" permission is missing).' : 'Sign in to Twitch to send whispers.',
    yes: 'Sign in',
    no: 'Not now',
    onYes: () => tvSignIn({ accountId: again ? state.auth.active : null }),
  });
}

/** "New whisper": a login, looked up with Helix /users; opens its thread. */
async function newWhisper(nav) {
  const r = await promptText({ title: 'New whisper', placeholder: 'Twitch user name', maxLength: 25, help: 'Who do you want to whisper? Type their Twitch user name.' });
  if (!r || r.action !== 'save') return;
  const login = r.value.trim().toLowerCase().replace(/^@/, '');
  if (!LOGIN_RE.test(login)) { toast('That isn\'t a Twitch user name', 3000, 'warn'); return; }
  let u = null;
  try {
    const res = await window.lurkbox.helix({ path: '/users', query: { login }, method: 'GET' });
    u = res && res.ok && res.data && res.data.data ? res.data.data[0] : null;
  } catch { u = null; }
  if (!u) { toast(`No Twitch user called ${login}`, 3000, 'warn'); return; }
  if (state.auth.user && String(u.id) === String(state.auth.user.id)) { toast('That\'s you!', 2500, 'warn'); return; }
  pics.set(String(u.id), u.profile_image_url || '');
  nav.push(whisperThreadView({ id: String(u.id), login: u.login, name: u.display_name || u.login }));
}

export function whispersView() {
  let off = () => {};
  return {
    id: 'whispers',
    title: 'Whispers',
    destroy() { off(); },
    mount(host, nav) {
      const svc = whispers();
      const list = el('div', { class: 'whisper-list' });
      const newBtn = button('New whisper', () => newWhisper(nav), { class: 'primary whisper-new', dataset: { focusKey: 'whisper-new' } });
      host.append(el('header', { class: 'view-header whispers-head' }, el('h1', {}, 'Whispers'), newBtn), list);
      const render = () => {
        const had = list.contains(document.activeElement) ? focusKey(document.activeElement) : null;
        const blocked = blockedState(svc, nav);
        newBtn.hidden = !!blocked;
        if (blocked) { list.replaceChildren(blocked); return; }
        const now = Date.now();
        if (!svc.threads.length) {
          list.replaceChildren(el('div', { class: 'empty' }, el('p', {}, 'No whispers yet. Whispers to you show up here while Lurkbox runs.'),
            el('p', { class: 'hint' }, 'They are kept on this device only, for this account.')));
          return;
        }
        list.replaceChildren(...svc.threads.map((t) => {
          const last = t.messages[t.messages.length - 1];
          return el('button', {
            type: 'button', class: `whisper-row focusable${t.unread ? ' unread' : ''}`, dataset: { focusKey: `whisper:${t.id}`, peer: t.id },
            'aria-label': `${t.name}${t.unread ? ', unread' : ''}`,
            onclick: () => nav.push(whisperThreadView({ id: t.id, login: t.login, name: t.name })),
          },
          peerAvatar(t, 'acct-avatar whisper-avatar'),
          el('span', { class: 'whisper-row-main' },
            el('span', { class: 'whisper-row-name' }, t.name, t.login && t.login !== t.name.toLowerCase() ? el('span', { class: 'whisper-login' }, ` @${t.login}`) : null),
            el('span', { class: 'whisper-row-preview' }, last ? `${last.me ? 'You: ' : ''}${last.text}` : '')),
          el('span', { class: 'whisper-row-side' },
            el('span', { class: 'whisper-row-time' }, last ? whisperTime(last.at, now) : ''),
            t.unread ? el('span', { class: 'whisper-dot', 'aria-hidden': 'true' }) : null));
        }));
        if (had) { const n = list.querySelector(`[data-focus-key="${CSS.escape(had)}"]`); if (n) focusEl(n, { instant: true }); }
      };
      const onChange = () => render();
      svc.addEventListener('change', onChange);
      off = () => svc.removeEventListener('change', onChange);
      render();
      loadPictures(svc.threads).then((fresh) => { if (fresh && host.isConnected) render(); });
    },
  };
}

/** One conversation: the messages (oldest at the top) and the composer. */
export function whisperThreadView(peer) {
  let off = () => {};
  let composer = null;
  let scroller = null;
  return {
    id: `whisper:${peer.id}`,
    title: peer.name,
    initialFocus: '.cm-input',
    destroy() { off(); whispers().setOpen(null); },
    onAction(action, source) {
      const a = document.activeElement;
      if (!composer || !composer.contains(a)) return false;
      if (action === UP || action === DOWN) {
        if (scroller) scroller.scrollBy({ top: (action === UP ? -1 : 1) * scroller.clientHeight * 0.4 });
        return true;
      }
      return composer.handle(action, source);
    },
    mount(host, nav) {
      const svc = whispers();
      const t0 = svc.thread(peer.id) || { ...peer, messages: [] };
      scroller = el('div', { class: 'whisper-messages', role: 'log', 'aria-live': 'polite' });
      composer = new Composer({
        label: `Whisper ${peer.name}`,
        maxLength: svc.limitFor(peer.id),
        onLeave: () => nav.pop(),
        onSend: async (text) => {
          const res = await svc.send(peer, text);
          if (!res.ok) {
            if (res.kind === 'auth') promptWhisperSignIn(res.auth || 'reauth');
            else toast(res.reason, res.kind === 'phone' ? 8000 : 4500, 'warn');
          }
          // A refused whisper stays in the thread (marked "not sent"), so the box is cleared either way unless it never went out.
          return { ok: res.ok || !['cooldown', 'auth', 'too-long', 'empty', 'self'].includes(res.kind) };
        },
      });
      composer.setVisible(true);
      composer.node.classList.add('whisper-composer');
      host.classList.add('whisper-thread');
      host.append(
        el('header', { class: 'view-header whisper-thread-head' },
          peerAvatar(t0, 'acct-avatar whisper-avatar'),
          el('h1', {}, peer.name),
          peer.login ? el('span', { class: 'whisper-login' }, `@${peer.login}`) : null,
          el('span', { class: 'hint whisper-thread-hint' }, hint('{A} type · {UP}{DOWN} scroll · {B} back'))),
        scroller,
        composer.node);
      const render = () => {
        const t = svc.thread(peer.id);
        const msgs = t ? t.messages : [];
        const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        const now = Date.now();
        scroller.replaceChildren(...(msgs.length ? msgs.map((m) => el('div', { class: `wmsg ${m.me ? 'me' : 'them'}${m.failed ? ' failed' : ''}`, dataset: { id: m.id } },
          el('div', { class: 'wmsg-text' }, m.text),
          el('div', { class: 'wmsg-meta' }, m.failed ? `Not sent: ${m.failed}` : whisperTime(m.at, now))))
          : [el('p', { class: 'hint whisper-start' }, `Start a conversation with ${peer.name}. Your first whisper can be up to 500 characters.`)]));
        composer.setMaxLength(svc.limitFor(peer.id));
        if (atEnd || !scroller.dataset.drawn) scroller.scrollTop = scroller.scrollHeight;
        scroller.dataset.drawn = '1';
      };
      const onChange = () => render();
      svc.addEventListener('change', onChange);
      off = () => svc.removeEventListener('change', onChange);
      svc.setOpen(peer.id);
      render();
      requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
      if (!pics.has(peer.id)) loadPictures([t0]).then(() => { const a = host.querySelector('.whisper-thread-head .whisper-avatar'); if (a && pics.get(peer.id)) a.replaceWith(peerAvatar(t0, 'acct-avatar whisper-avatar')); });
      if (svc.authState() !== 'ok') { const b = blockedState(svc, nav); if (b) { composer.setVisible(false); host.append(b); } }
    },
  };
}
