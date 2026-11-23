// The app side of social.js: one subscription checker and one block list for the signed-in account, the sub badges on
// Following, the chat user card (View channel, Block), the channel page's Block button, and the Settings → Account
// screens "Subscriptions" and "Blocked users".
import { el, button, toast } from './ui.js';
import { helix, followedChannels } from './api.js';
import { state, onState, onAccountRemoved } from './state.js';
import { confirmDialog, openModal } from './modal.js';
import { SubChecker, BlockList, confirmBlock, confirmUnblock, subDetail, tierBadge } from './social.js';
import { errorState } from './grid.js';
import { focusEl } from './focus.js';

const me = () => (state.auth.user && state.auth.user.id) || null;

export const subs = new SubChecker({ helix: (path, query) => helix(path, query) });
export const blocks = new BlockList({ helix: (path, query, opts) => helix(path, query, opts) });

/** Loads the block list for the account on screen (and again after switching accounts). Safe to call often. */
export function refreshBlocks(opts) {
  if (!state.auth.signedIn) return Promise.resolve([]);
  return blocks.load(me(), opts).catch((e) => { console.warn('[blocks] load failed', e.message); return blocks.items; });
}
onState((what) => { if (what === 'account' || what === 'signin') refreshBlocks(); });
// A signed-out account's subscriptions and block list leave memory with it.
onAccountRemoved(() => { subs.clear(); blocks.load(null); });

/** Checks the subscriptions of these followed channels (cached 1 h); onResult(id, sub|null) as answers come in. */
export function checkSubs(broadcasterIds, opts) {
  const id = me();
  if (!id || !broadcasterIds.length) return Promise.resolve(new Map());
  return subs.checkAll(id, broadcasterIds, opts);
}

/** Adds (or removes) the sub badge on one card: data-k = the broadcaster id. */
export function paintSubBadge(card, sub) {
  if (!card) return;
  const holder = card.querySelector('.card-thumb, .card-avatar');
  if (!holder) return;
  let b = holder.querySelector('.badge.sub');
  if (!sub) { if (b) b.remove(); return; }
  if (!b) { b = el('span', { class: 'badge sub' }); holder.append(b); }
  b.textContent = tierBadge(sub.tier);
  b.title = subDetail(sub);
}

/** The sub badges for every card in these grids, from what is cached (no requests). */
export function paintSubBadges(...grids) {
  const id = me();
  if (!id) return;
  for (const g of grids) for (const card of g.querySelectorAll('[data-k]')) {
    const sub = subs.cached(id, card.dataset.k);
    if (sub !== undefined) paintSubBadge(card, sub);
  }
}

/** Block someone, after a "Yes". user: { id, login, name }. */
export function blockUser(user) {
  return confirmBlock(user, { confirm: confirmDialog, list: blocks, toast });
}
export function unblockUser(user) {
  return confirmUnblock(user, { confirm: confirmDialog, list: blocks, toast });
}

/**
 * The small card for a chat user: their name, View channel and Block/Unblock. Your own name gets just View channel.
 * openChannel(user) leaves the player for the channel page.
 */
export function openUserCard(user, { openChannel }) {
  const name = user.name || user.login;
  const self = String(user.id) === String(me());
  const blocked = blocks.has(user.id);
  const content = el('div', { class: 'user-card' },
    user.login && user.login !== String(name).toLowerCase() ? el('div', { class: 'social-sub' }, user.login) : null,
    el('div', { class: 'user-card-actions' },
      user.login ? button('View channel', () => { m.close(); openChannel(user); }, { class: 'primary', dataset: { focusKey: 'uc-channel' } }) : null,
      // Whispers aren't in Lurkbox yet; the button appears here once they are.
      !self && user.id && state.auth.signedIn
        ? button(blocked ? 'Unblock' : 'Block', () => { m.close(); (blocked ? unblockUser : blockUser)(user); }, { class: 'user-card-block', dataset: { focusKey: 'uc-block' } })
        : null,
      button('Close', () => m.close())));
  const m = openModal({ title: name, content, class: 'user-card-modal' });
  return m;
}

/** The channel page's Block / Unblock button (not on your own channel). */
export function blockButton(ch) {
  if (!state.auth.signedIn || String(ch.id) === String(me())) return null;
  const b = button('Block', () => (blocks.has(ch.id) ? unblockUser(ch) : blockUser(ch)), { class: 'block-btn', dataset: { focusKey: 'channel-block' } });
  const paint = () => { b.textContent = blocks.has(ch.id) ? 'Unblock' : 'Block'; };
  const off = blocks.subscribe(() => { if (!b.isConnected) { off(); return; } paint(); });
  refreshBlocks().then(paint);
  return b;
}

function rowItem(main, sub, ...actions) {
  return el('div', { class: 'social-row' },
    el('div', { class: 'social-text' }, el('div', { class: 'social-name' }, main), sub ? el('div', { class: 'social-sub' }, sub) : null),
    el('div', { class: 'social-actions' }, ...actions));
}

/** Settings → Account → Subscriptions: your followed channels you're subscribed to. */
export function subscriptionsView() {
  let stop = false;
  return {
    id: 'subscriptions',
    title: 'Subscriptions',
    destroy() { stop = true; },
    async mount(host, nav) {
      const status = el('p', { class: 'hint social-status' }, 'Checking the channels you follow…');
      const list = el('div', { class: 'social-list' });
      host.append(el('header', { class: 'view-header' }, el('h1', {}, 'Subscriptions')),
        el('p', { class: 'hint' }, 'Twitch lists subscriptions one channel at a time, so Lurkbox checks the channels you follow (remembered for an hour).'),
        status, list);
      let follows;
      try { follows = await followedChannels(); } catch (e) { status.remove(); host.append(errorState(e, nav)); return; }
      const byId = new Map(follows.map((f) => [String(f.broadcaster_id), f]));
      const found = [];
      let done = 0;
      const paint = () => {
        found.sort((a, b) => a.name.localeCompare(b.name));
        list.replaceChildren(...found.map((s) => rowItem(s.name, subDetail(s),
          button('Channel page', () => nav.openChannel({ login: s.login, id: s.broadcasterId, name: s.name }), { dataset: { focusKey: `sub-${s.broadcasterId}` } }))));
      };
      const progress = () => {
        status.textContent = done < byId.size ? `Checked ${done} of ${byId.size} channels…` : (found.length ? `${found.length} ${found.length === 1 ? 'subscription' : 'subscriptions'} among the ${byId.size} channels you follow.` : `No subscriptions among the ${byId.size} channels you follow.`);
      };
      progress();
      await checkSubs([...byId.keys()], {
        cancelled: () => stop,
        onResult: (id, sub) => {
          done++;
          if (sub) {
            const f = byId.get(id);
            found.push({ ...sub, login: sub.login || (f && f.broadcaster_login) || '', name: sub.name || (f && f.broadcaster_name) || id });
            paint();
          }
          progress();
        },
      });
      done = byId.size;
      progress();
    },
  };
}

/** Settings → Account → Blocked users: everyone you've blocked, with Unblock (after a confirm). */
export function blockedView() {
  let off = null;
  return {
    id: 'blocked-users',
    title: 'Blocked users',
    destroy() { if (off) off(); },
    async mount(host, nav) {
      const status = el('p', { class: 'hint social-status' }, 'Loading…');
      const list = el('div', { class: 'social-list' });
      host.append(el('header', { class: 'view-header' }, el('h1', {}, 'Blocked users')), status, list);
      const paint = (items) => {
        status.textContent = items.length ? `${items.length} blocked ${items.length === 1 ? 'user' : 'users'}. Their messages are ${state.settings.hideBlockedChat !== false ? 'hidden' : 'shown'} in Lurkbox chat.` : 'You haven’t blocked anyone.';
        list.replaceChildren(...items.map((b) => rowItem(b.name || b.login, b.login && b.login !== (b.name || '').toLowerCase() ? b.login : null,
          button('Unblock', () => unblockUser(b), { dataset: { focusKey: `unblock-${b.id}` } }))));
        // The unblocked row's button is gone: focus the next one (or Back is all that's left).
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) { const n = list.querySelector('.focusable'); if (n) focusEl(n, { instant: true }); }
      };
      try { await blocks.load(me(), { maxAgeMs: 0 }); } catch (e) { status.remove(); host.append(errorState(e, nav)); return; }
      paint(blocks.items);
      off = blocks.subscribe(paint);
    },
  };
}
