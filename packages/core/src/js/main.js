// Renderer entry: router, left rail, input dispatch and startup routing.
import { initState, state, onState, applyTheme, applyDisplay, flushSettings } from './state.js';
import { handleSliderAction } from './slider.js';
import { Input, A, B, Y, LB, RB, LEFT, RIGHT, DIRECTIONS } from './input.js';
import { moveFocus, focusFirst, focusEl, focusables } from './focus.js';
import { snapshotFocus, restoreFocus, focusKey as stableFocusKey } from './focus-keep.js';
import { hasModal, handleModalAction } from './modal.js';
import { openKeyboard } from './osk.js';
import { openSignIn, tvSignIn } from './auth.js';
import { Player } from './player.js';
import { RaidWatcher } from './eventsub.js';
import { el, toast } from './ui.js';
import { tw } from './api.js';
import { installMarquee } from './marquee.js';
import { keepFocusOutOfFrames } from './frame-focus.js';
import { mascotEl, iconDataUrl } from './mascot.js';
import { UnfocusedMode, resolveBack, quitWithCleanup } from './lifecycle.js';
import { onPlayerLogin } from './player-login.js';
import { accountMenu, whosWatching, avatar } from './accounts.js';
import { openModal } from './modal.js';
import { button } from './ui.js';
import { followingView } from './views/following.js';
import { browseView } from './views/browse.js';
import { categoriesView } from './views/categories.js';
import { searchView } from './views/search.js';
import { dropsView } from './views/drops.js';
import { settingsView } from './views/settings.js';
import { channelView } from './views/channel.js';

const TOP = {
  following: followingView,
  browse: browseView,
  categories: categoriesView,
  search: searchView,
  drops: dropsView,
  settings: settingsView,
};
const TOP_ORDER = Object.keys(TOP);

const appEl = document.getElementById('app');
const rail = document.getElementById('rail');
const content = document.getElementById('content');

/** Stack of { view, host, focus } for the current top-level section. */
let stack = [];
let currentTop = null;
let lastContentFocus = null;
let pendingFocus = null; // { key, index } to restore when content appears
let playerReturnFocus = null;

// ---------- focus helpers ----------

function focusKey(node) { return stableFocusKey(node); }

function topEntry() { return stack[stack.length - 1]; }

function railButton(id) { return rail.querySelector(`[data-view="${id}"]`); }

/** When async content renders, put focus on it if nothing useful is focused. */
function tryPendingFocus() {
  if (!pendingFocus || hasModal() || player.active) return;
  const host = topEntry() && topEntry().host;
  if (!host) return;
  const active = document.activeElement;
  const lost = !active || active === document.body || !active.isConnected || (host.contains(active) === false && !rail.contains(active));
  if (!lost && !pendingFocus.force) return;
  const list = focusables(host);
  if (!list.length) return;
  let target = null;
  if (pendingFocus.key) target = list.find((n) => focusKey(n) === pendingFocus.key);
  if (!target && pendingFocus.selector) target = list.find((n) => n.matches(pendingFocus.selector));
  if (!target && Number.isInteger(pendingFocus.index)) target = list[Math.min(pendingFocus.index, list.length - 1)];
  if (!target && pendingFocus.fallbackRail) return; // keep focus on the rail
  target = target || list[0];
  focusEl(target, { instant: true });
  pendingFocus = null;
}

new MutationObserver(() => tryPendingFocus()).observe(content, { childList: true, subtree: true });

// ---------- views ----------

function mount(view) {
  const host = el('section', { class: 'view', dataset: { view: view.id } });
  content.append(host);
  const entry = { view, host, focus: null };
  try {
    const r = view.mount(host, nav);
    if (r && r.catch) r.catch((e) => console.error('[view] mount failed', e));
  } catch (e) {
    console.error('[view] mount failed', e);
    host.append(el('div', { class: 'empty' }, el('p', {}, `This screen failed to load: ${e.message}`)));
  }
  return entry;
}

function markRail() {
  for (const b of rail.querySelectorAll('[data-view]')) b.classList.toggle('current', b.dataset.view === currentTop);
}

const pollers = new Set();
let blurredAt = null;

const nav = {
  registerPoller(p) { pollers.add(p); },
  unregisterPoller(p) { pollers.delete(p); },
  /** Live lists poll only when visible and in use. */
  canPoll() {
    if (player && player.active) return false;
    if (hasModal()) return false;
    if (document.visibilityState === 'hidden') return false;
    if (blurredAt && Date.now() - blurredAt > 60000) return false;
    return true;
  },
  isNavigating() { return !!(input && input.lastDirAt && performance.now() - input.lastDirAt < 300); },
  pokePollers() { for (const p of pollers) p.poke(); },

  goTop(id, { focusContent = true } = {}) {
    if (!TOP[id]) return;
    currentTop = id;
    for (const e of stack) { if (e.view.destroy) e.view.destroy(); e.host.remove(); }
    stack = [mount(TOP[id]())];
    lastContentFocus = null;
    markRail();
    content.scrollTop = 0;
    pendingFocus = focusContent ? { index: 0, force: true } : { fallbackRail: true };
    if (!focusContent) focusEl(railButton(id), { instant: true });
    tryPendingFocus();
  },

  push(view) {
    const cur = topEntry();
    if (cur) {
      cur.focus = document.activeElement;
      cur.scroll = content.scrollTop;
      cur.host.hidden = true;
    }
    stack.push(mount(view));
    content.scrollTop = 0;
    pendingFocus = { index: 0, force: true };
    tryPendingFocus();
  },

  pop() {
    if (stack.length <= 1) return false;
    const gone = stack.pop();
    if (gone.view.destroy) gone.view.destroy();
    gone.host.remove();
    const cur = topEntry();
    cur.host.hidden = false;
    content.scrollTop = cur.scroll || 0;
    if (cur.focus && cur.focus.isConnected) focusEl(cur.focus, { instant: true });
    else { pendingFocus = { index: 0, force: true }; tryPendingFocus(); }
    return true;
  },

  /** Re-mounts the current view, keeping focus on the same control when possible. */
  refresh() {
    const cur = topEntry();
    if (!cur) return;
    const snap = snapshotFocus(cur.host, focusables(cur.host), content);
    const fresh = mount(cur.view);
    cur.host.replaceWith(fresh.host);
    stack[stack.length - 1] = fresh;
    // Same control (or its nearest neighbour) and the same scroll position, with no animation.
    const back = restoreFocus(fresh.host, snap, focusables(fresh.host), (n) => focusEl(n, { instant: true }), content);
    pendingFocus = snap.had && !back ? { index: Math.max(0, snap.index), force: true } : null;
    tryPendingFocus();
  },

  playStream(s, list) {
    nav.openPlayer(() => player.openLive({ login: s.user_login, name: s.user_name, userId: s.user_id, stream: s }, list));
  },
  playChannel({ login, name, userId }) {
    nav.openPlayer(() => player.openLive({ login, name, userId }, []));
  },
  playVideo(v) {
    nav.openPlayer(() => player.openVideo(v));
  },
  openPlayer(start) {
    if (!player.active) playerReturnFocus = document.activeElement;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    start();
  },
  closePlayer() {
    player.close();
    setTimeout(() => nav.pokePollers(), 0); // back from the player: refresh right away
    if (playerReturnFocus && playerReturnFocus.isConnected) focusEl(playerReturnFocus, { instant: true });
    else { pendingFocus = { index: 0, force: true }; tryPendingFocus(); }
    playerReturnFocus = null;
    if (pendingReturnToSignIn) {
      pendingReturnToSignIn = false;
      nav.goTop('following');
    }
  },

  openChannel(c) { nav.push(channelView(c)); },
  /** Focus the current section's rail button (B out of a view that keeps the controller, like Drops). */
  focusRail() { focusEl(railButton(currentTop)); },

  /** One sign-in on the TV (covers the player too). */
  signIn() {
    tvSignIn({ onSuccess: () => { if (!player.active) nav.goTop('following'); } });
  },
  /** Fallback: code + QR on another device; the player stays signed out. */
  phoneSignIn() {
    openSignIn({ onSuccess: () => { if (!player.active) nav.goTop('following'); } });
  },
};

// ---------- input dispatch ----------

function dispatch(action, source) {
  if (hasModal()) { handleModalAction(action, source); return; }
  if (player.active) { player.handle(action, source); return; }

  const entry = topEntry();
  if (entry && entry.view.onAction && entry.view.onAction(action)) return;
  if (handleSliderAction(action)) return; // LEFT/RIGHT on a focused slider (Settings → Chat)
  const active = document.activeElement;
  const inRail = rail.contains(active);
  const inContent = entry && entry.host.contains(active);

  if (DIRECTIONS.includes(action)) {
    if (!inRail && !inContent) {
      if (!focusFirst(entry ? entry.host : content)) focusEl(railButton(currentTop), { instant: true });
      return;
    }
    if (inRail && action === RIGHT) {
      if (lastContentFocus && lastContentFocus.isConnected && entry.host.contains(lastContentFocus) && focusables(entry.host).includes(lastContentFocus)) {
        focusEl(lastContentFocus);
      } else {
        focusFirst(entry.host);
      }
      return;
    }
    const scope = inRail ? rail : appEl;
    const next = moveFocus(action, scope);
    if (next && inContent && rail.contains(next)) {
      // Entering the rail always lands on the current section.
      lastContentFocus = active;
      focusEl(railButton(currentTop));
    }
    if (!next && inContent && action === LEFT) {
      lastContentFocus = active;
      focusEl(railButton(currentTop));
    }
    return;
  }

  switch (action) {
    case A: {
      if (!active || active === document.body) { tryPendingFocus(); return; }
      if (active.tagName === 'INPUT' && active.type !== 'range') {
        if (source === 'key') {
          // Physical Enter submits the field.
          active.dispatchEvent(new Event('osk-done'));
          return;
        }
        openKeyboard({
          title: active.dataset.osk || 'Enter text',
          value: active.value,
          onDone: (v) => { active.value = v; active.dispatchEvent(new Event('osk-done')); },
        });
        return;
      }
      active.click();
      return;
    }
    case B: {
      const what = resolveBack({ stackDepth: stack.length, inRail, currentTop });
      if (what === 'pop') nav.pop();
      else if (what === 'to-rail') { if (inContent) lastContentFocus = active; focusEl(railButton(currentTop)); }
      else if (what === 'home') nav.goTop('following', { focusContent: false });
      else if (what === 'exit') askExit();
      return;
    }
    case Y:
      if (['following', 'browse', 'categories'].includes(currentTop) && stack.length === 1) nav.refresh();
      return;
    case LB:
    case RB: {
      const i = TOP_ORDER.indexOf(currentTop);
      const next = TOP_ORDER[(i + (action === RB ? 1 : -1) + TOP_ORDER.length) % TOP_ORDER.length];
      nav.goTop(next);
      return;
    }
    default:
      return;
  }
}

// ---------- exit ----------

let exiting = false;
function exitNow() {
  if (exiting) return;
  exiting = true;
  quitWithCleanup([
    () => player && player.watcher.shutdown(), // delete the EventSub subscription
    () => player && player.chat.leave(),
    () => player && player.saveResume(), // where this VOD was, for next time
    () => flushSettings(), // a slider moved in the last moment
  ], () => window.lurkbox.quit(), 500);
}

function askExit() {
  if (!state.settings.confirmExit) { exitNow(); return; }
  const m = openModal({
    title: 'Exit Lurkbox?',
    class: 'exit-modal',
    content: el('div', { class: 'row' },
      button('Exit', () => { m.close(); exitNow(); }, { class: 'primary exit-yes' }),
      button('Cancel', () => m.close(), { class: 'exit-no' })),
    focus: '.exit-yes',
    onAction(action) {
      if (action === B) { m.close(); exitNow(); return true; } // B, B exits quickly
      return false;
    },
  });
}

// ---------- rail ----------

const ICONS = {
  following: '<path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.2 4.5 6.9 4.5c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3 3.7 0 5.9 3.8 4.4 7.3C19.5 16.4 12 21 12 21z"/>',
  browse: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  categories: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  // A gift box (a drop reward).
  drops: '<rect x="4" y="11" width="16" height="10" rx="1.5"/><path d="M12 11v10M4 15h16M12 11c-1.5-3-5-4-5-1.5S10 11 12 11zM12 11c1.5-3 5-4 5-1.5S14 11 12 11z"/>',
  // Gear (Feather "settings" icon, MIT licence).
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const LABELS = { following: 'Following', browse: 'Browse', categories: 'Categories', search: 'Search', drops: 'Drops', settings: 'Settings' };

function buildRail() {
  rail.replaceChildren(
    el('div', { class: 'brand' }, mascotEl('brand-mark'), el('span', { class: 'brand-name' }, 'Lurkbox')),
    el('button', { class: 'rail-item rail-account focusable', type: 'button', dataset: { view: 'account' }, onclick: () => accountMenu(nav) }),
    el('div', { class: 'rail-items' }, TOP_ORDER.map((id) => el('button', {
      class: 'rail-item focusable',
      type: 'button',
      dataset: { view: id },
      onclick: () => nav.goTop(id),
    },
    el('span', { class: 'rail-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg>` }),
    el('span', { class: 'rail-label' }, LABELS[id])))),
    el('div', { class: 'rail-user' }));
  updateRailUser();
}

function updateRailUser() {
  const u = rail.querySelector('.rail-user');
  if (u) u.textContent = '';
  const b = rail.querySelector('.rail-account');
  if (!b) return;
  const me = state.auth.accounts && state.auth.accounts.find((a) => a.id === state.auth.active);
  b.hidden = !(state.auth.accounts && state.auth.accounts.length);
  b.replaceChildren(avatar(me), el('span', { class: 'rail-label' }, me ? (me.display_name || me.login) : 'Sign in'));
}

// ---------- startup ----------

let input;
let player;

// Window/taskbar icon follows the theme (desktop mode; Gamescope ignores it).
let iconTimer = null;
window.addEventListener('themechange', () => {
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    try {
      if (window.lurkbox.setWindowIcon) await window.lurkbox.setWindowIcon(await iconDataUrl(256));
    } catch (e) {
      console.warn('[icon] could not render the themed icon', e.message);
    }
  }, 300);
});

keepFocusOutOfFrames({ isMouse: () => !!input && input.mode.mode === 'mouse' });
let pendingReturnToSignIn = false;

async function start() {
  await initState();
  // Demo mode (README screenshots; desktop LURKBOX_DEMO=1): fake clock, chat and emote APIs, no network. See demo/.
  if (state.info.demo) (await import('./demo/install.js')).installDemo(window, state.info.demo);
  applyTheme(state.settings.theme);
  applyDisplay();
  window.addEventListener('resize', applyDisplay); // the Twitch chat panel width depends on the window width
  document.body.classList.toggle('windowed', !!state.info.windowed);
  const watcher = new RaidWatcher();
  player = new Player({ nav, watcher });
  window.__lurkbox = { nav, player, watcher, state, dispatch }; // for debugging from DevTools

  input = new Input(dispatch);
  input.onRelease = (a) => { if (player.active && !hasModal()) player.release(a); };
  installMarquee();
  input.allowUnfocused = !!state.settings.inputWhenUnfocused;

  buildRail();

  // After a player sign-in, reload the embed so it picks up the twitch.tv session.
  onPlayerLogin(() => {
    const c = player.current;
    if (!player.active || !c) return;
    player.embed = null;
    if (c.kind === 'live') player.openLive({ login: c.login, name: c.name, userId: c.userId, stream: c.stream });
    else if (c.video) player.openVideo(c.video);
  });

  // Video only while unfocused (player screen only); focus events come from the main process.
  const unfocused = new UnfocusedMode({ onChange: (on) => document.body.classList.toggle('video-only', on) });
  unfocused.setEnabled(state.settings.videoOnlyUnfocused !== false);
  // Quality while in the background: after 3 s unfocused, the direct engine drops to the chosen cap.
  const background = new UnfocusedMode({ delay: 3000, onChange: (on) => player.setBackground(on) });
  window.lurkbox.onWindowFocus((f) => { unfocused.setFocus(f); background.setFocus(f); blurredAt = f ? null : Date.now(); if (f) nav.pokePollers(); });
  setInterval(() => nav.pokePollers(), 5000); // re-check pause conditions (modal, player, long blur)
  onState(() => {
    unfocused.setEnabled(state.settings.videoOnlyUnfocused !== false);
    player.applyBackground(); // the setting may have changed
  });

  let hadClientId = state.auth.hasClientId;
  onState((what) => {
    if (input) input.allowUnfocused = !!state.settings.inputWhenUnfocused;
    applyDisplay();
    updateRailUser();
    if (what === 'account') {
      player.watcher.kick(); // move the raid subscription to the new account
      if (!player.active) nav.goTop('following');
      return;
    }
    if (what === 'signin') {
      if (state.auth.signedIn) {
        if (!player.active) nav.goTop('following');
      } else if (currentTop === 'settings') {
        nav.refresh();
      } else {
        toast('Signed out. Please sign in again.', 5000, 'warn');
        if (player.active) pendingReturnToSignIn = true;
        else nav.goTop('following');
      }
    } else if (what === 'settings' && hadClientId !== state.auth.hasClientId) {
      hadClientId = state.auth.hasClientId;
      if (currentTop !== 'settings') nav.refresh();
    }
  });

  if (state.auth.accounts && state.auth.accounts.length >= 2 && state.settings.profilePicker === 'ask' && !state.info.startChannel && !state.info.startVod) {
    nav.goTop('following');
    await whosWatching();
  } else if (!state.auth.hasClientId) {
    nav.goTop('settings');
    toast('Add a Twitch Client ID to get started', 6000, 'warn');
  } else {
    nav.goTop('following');
  }

  if (state.info.startChannel) nav.playChannel({ login: state.info.startChannel, name: state.info.startChannel });
  if (state.info.startVod) {
    let v = { id: state.info.startVod, title: '', user_login: '', user_name: '', user_id: null };
    if (state.auth.signedIn) { try { v = (await tw.videoById(state.info.startVod)) || v; } catch { /* keep the stub */ } }
    nav.playVideo(v);
  }
  // Channels opened from the Lurkbox Decky plugin (a clicked go-live toast; src/main/open-request.js).
  const openRequested = (r) => {
    if (!r || !r.channel) return;
    if (player.active && player.current && player.current.kind === 'live' && player.current.login === r.channel) return;
    nav.playChannel({ login: r.channel, name: r.name || r.channel });
  };
  window.lurkbox.onOpenChannel(openRequested);
  // Drops auto-claim (the host checks Twitch's inventory page in the background).
  if (window.lurkbox.onDropsEvent) window.lurkbox.onDropsEvent((ev) => { if (ev && ev.type === 'claimed') toast(`Drop claimed: ${ev.name}`, 5000); });
  window.lurkbox.openReady().then(openRequested).catch(() => {});
  console.log(`[lurkbox] ready (signedIn=${state.auth.signedIn}, clientId=${state.auth.hasClientId})`);
}

start().catch((e) => {
  console.error('[lurkbox] startup failed', e);
  document.body.append(el('pre', { class: 'fatal' }, `Lurkbox failed to start:\n${e.stack || e}`));
});
