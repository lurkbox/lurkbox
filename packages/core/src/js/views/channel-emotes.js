// The channel page's Emotes tab: sub-tabs 7TV, BTTV, FFZ and Twitch (with counts), a search box, a grid of large
// previews with names (overlay emotes badged), and a detail panel for the focused emote. A adds the emote to this
// channel's chat draft (the player takes it when it opens the channel), Y adds it to the channel's quick-chat phrases.
// The third-party sets come from the chat's own loaders and cache; the Twitch tab is Helix GET /chat/emotes.
// The data shaping and both actions are in ../emote-browser.js.
import { el, button, toast } from '../ui.js';
import { hint } from '../input.js';
import { helix } from '../api.js';
import { filterPills } from '../grid.js';
import { focusEl } from '../focus.js';
import { emoteImg } from '../chat-render.js';
import { emoteCache } from '../emote-providers.js';
import { ChannelEmoteCache } from '../user-emotes.js';
import { keyboardFor } from '../text-entry.js';
import { state, saveSettings } from '../state.js';
import { pushRecent, MAX_PHRASES } from '../../shared/quick-chat.js';
import {
  EMOTE_TABS, PROVIDER_NAMES, shapeEmotes, filterEmotes, tabLabel, bigUrl, emoteFacts, emptyText,
  draftAvailability, addToDraft, peekDraft, addEmotePhrase,
} from '../emote-browser.js';

/** Cells added at a time; more follow as the focus or the scroll nears the end (7TV sets run to hundreds). */
const CHUNK = 96;
const twitchEmotes = new ChannelEmoteCache((path, query) => helix(path, query));
let lastTab = '7tv'; // the sub-tab, kept for the session

/** Renders the tab into `body`. ctx: { ch: { id, login, name }, nav, view } (view.tabAction gets A/Y). */
export function renderEmotes(body, { ch, view }) {
  const animated = state.settings.chatAnimatedEmotes !== false;
  const loads = new Map(); // sub-tab → Promise<{ emotes } | { error }>
  const load = (tab) => {
    if (!loads.has(tab)) {
      const p = tab === 'twitch' ? twitchEmotes.get(ch.id, { animated }) : emoteCache.get(tab, ch.id, { animated }).then((r) => r.emotes);
      loads.set(tab, p.then((list) => ({ emotes: shapeEmotes(list) }), (error) => ({ error })));
    }
    return loads.get(tab);
  };

  let tab = EMOTE_TABS.some((t) => t.value === lastTab) ? lastTab : '7tv';
  let query = '';
  let list = []; // the shown (filtered) emotes
  let shown = 0; // cells rendered so far
  let selected = null;

  const pills = filterPills({
    items: EMOTE_TABS, key: 'eb', label: 'Emote provider', value: tab,
    onPick: (v) => { tab = lastTab = v; showGrid(); },
  });
  const input = el('input', {
    class: 'text-input focusable eb-search', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Search emotes', 'aria-label': 'Search emotes', maxlength: '50', dataset: { focusKey: 'eb-search' },
  });
  const grid = el('div', { class: 'eb-grid', role: 'grid', 'aria-label': 'Emotes' });
  const sentinel = el('div', { class: 'eb-sentinel', 'aria-hidden': 'true' });
  const detail = el('aside', { class: 'eb-detail', 'aria-live': 'polite' });
  const draftLine = el('p', { class: 'hint eb-draft' });
  body.append(
    el('div', { class: 'channel-toolbar eb-toolbar' }, pills.el, input),
    el('div', { class: 'eb-main' }, el('div', { class: 'eb-grid-wrap' }, grid, sentinel), detail),
    el('p', { class: 'hint eb-hint' }, hint('{A} add to message · {Y} add to quick chat · {LB}/{RB} tabs')),
    draftLine);

  // Every sub-tab loads at once, so each pill shows its count.
  for (const t of EMOTE_TABS) {
    load(t.value).then((r) => {
      const pill = pills.el.querySelector(`[data-value="${t.value}"]`);
      if (pill) pill.textContent = tabLabel(t.value, r.emotes ? r.emotes.length : null);
    });
  }

  async function showGrid({ keepFocus = false } = {}) {
    const want = tab;
    const hadFocus = grid.contains(document.activeElement);
    grid.replaceChildren(el('div', { class: 'loading' }, 'Loading…'));
    const r = await load(want);
    if (want !== tab || !grid.isConnected) return;
    shown = 0;
    if (r.error) {
      list = [];
      const signIn = r.error.code === 'NOT_SIGNED_IN' || r.error.code === 'NO_CLIENT_ID';
      grid.replaceChildren(el('div', { class: 'empty eb-empty' }, el('p', {}, signIn
        ? 'Sign in to see this channel\'s Twitch emotes.'
        : `Couldn't load the ${PROVIDER_NAMES[want]} emotes. Try again later.`)));
      select(null);
      return;
    }
    list = filterEmotes(r.emotes, query);
    if (!r.emotes.length || !list.length) {
      grid.replaceChildren(el('div', { class: 'empty eb-empty' }, el('p', {}, !r.emotes.length
        ? emptyText(want, ch.name)
        : `No ${PROVIDER_NAMES[want]} emotes match "${query.trim()}".`)));
      select(null);
      return;
    }
    grid.replaceChildren();
    more();
    select(list[0]);
    if (keepFocus || hadFocus) focusEl(grid.firstElementChild, { instant: true });
  }

  function more() {
    const next = list.slice(shown, shown + CHUNK);
    grid.append(...next.map((e, i) => cell(e, shown + i)));
    shown += next.length;
  }

  function cell(e, i) {
    return el('button', {
      type: 'button', class: `eb-emote focusable${e.overlay ? ' overlay' : ''}`, role: 'gridcell', 'aria-label': e.overlay ? `${e.name}, zero-width` : e.name,
      dataset: { focusKey: `eb-${tab}-${e.name}`, i: String(i) },
      onclick: () => {
        // A touch selects first (the detail panel has the buttons); a controller's A or a click adds.
        if (document.body.classList.contains('input-touch') && selected !== e) { select(e); return; }
        addToMessage(e);
      },
    },
    el('span', { class: 'eb-pic' }, emoteImg(e, 'eb-img')),
    el('span', { class: 'eb-name' }, e.name),
    e.overlay ? el('span', { class: 'eb-badge', title: 'Zero-width: drawn over the emote before it' }, 'ZW') : null);
  }

  // The focus ring's event (focusin is deferred while the window lacks OS focus, as under Gamescope).
  grid.addEventListener('lurkbox-focus', (ev) => {
    const c = ev.target.closest('.eb-emote');
    if (!c) return;
    const i = Number(c.dataset.i);
    if (list[i]) select(list[i]);
    if (i >= shown - 24 && shown < list.length) more();
  });
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (!sentinel.isConnected) { io.disconnect(); return; }
      if (entries.some((x) => x.isIntersecting) && shown < list.length && shown > 0) more();
    }, { rootMargin: '600px 0px' });
    io.observe(sentinel);
  }

  function select(e) {
    selected = e;
    if (!e) { detail.replaceChildren(); detail.hidden = true; return; }
    detail.hidden = false;
    const big = el('img', { class: 'eb-big', src: bigUrl(e), alt: '', decoding: 'async', draggable: 'false' });
    big.addEventListener('error', () => { if (big.src !== e.url) big.src = e.url; }, { once: true });
    const facts = el('dl', { class: 'eb-facts' });
    for (const [k, v] of emoteFacts(e)) facts.append(el('dt', {}, k), el('dd', {}, v));
    detail.replaceChildren(
      el('div', { class: `eb-big-pic${e.overlay ? ' overlay' : ''}` }, big),
      el('h3', { class: 'eb-detail-name' }, e.name),
      facts,
      el('div', { class: 'eb-detail-actions' },
        button('Add to message', () => addToMessage(e), { class: 'eb-add', dataset: { focusKey: 'eb-add' } }),
        button('Add to quick chat', () => addToQuickChat(e), { class: 'eb-quick', dataset: { focusKey: 'eb-quick' } })));
  }

  function addToMessage(e) {
    const why = draftAvailability(state.auth, state.settings);
    if (why === 'signed-out') { toast('Sign in to chat first', 2500, 'warn'); return; }
    if (why === 'twitch-style') { toast('Twitch chat style has its own message box. Lurkbox chat (Settings → Chat) takes emotes from here.', 3500, 'warn'); return; }
    const text = addToDraft(ch.login, e.name);
    if (text == null) { toast('That would go over Twitch\'s 500-character limit', 2500, 'warn'); return; }
    toast('Added to message', 1800);
    paintDraft(text);
    const me = state.auth.user;
    if (me) saveSettings({ emoteRecents: pushRecent(state.settings.emoteRecents, me.id, e.name) }).catch(() => {});
  }

  function paintDraft(text) {
    draftLine.textContent = text ? `Your message for ${ch.name}: ${text.length > 80 ? `…${text.slice(-80)}` : text.trim()} (Watch to send it)` : '';
  }

  async function addToQuickChat(e) {
    const { qc, result } = addEmotePhrase(state.settings.quickChat, { id: ch.id, login: ch.login }, e.name);
    if (result === 'exists') { toast(`${e.name} is already in ${ch.name}'s quick chat`, 2200); return; }
    if (result === 'full') { toast(`At most ${MAX_PHRASES} phrases per list`, 2500, 'warn'); return; }
    await saveSettings({ quickChat: qc });
    toast(`Added to ${ch.name}'s quick chat`, 2000);
  }

  // Search: filters as you type (any keyboard); A on the box opens Steam's keyboard or the built-in one.
  let typing = null;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { if (input.value !== query) { query = input.value; showGrid(); } }, 150);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    ev.stopPropagation();
    query = input.value;
    showGrid({ keepFocus: true });
  });

  view.tabAction = (action) => {
    if (action === 'A' && document.activeElement === input) {
      keyboardFor(input, { title: 'Search emotes', maxLength: 50, onDone: () => { query = input.value; showGrid({ keepFocus: true }); } });
      return true;
    }
    if (action === 'Y' && selected) { addToQuickChat(selected); return true; }
    return false;
  };

  paintDraft(peekDraft(ch.login));
  showGrid();
}
