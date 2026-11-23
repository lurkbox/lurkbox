// Emote search (from Search → Emotes, or a channel's Emotes tab → Search all). Two scopes:
// - All of 7TV: 7TV's public search (seventv-search.js) as you type, sorted Popular / Trending / Newest, with
//   "animated only" and "zero-width only" filters, more pages as the focus or the scroll nears the end. Browse only.
// - Seen channels: every channel emote set Lurkbox has loaded for this account (emote-index-store.js); A opens that
//   channel's Emotes tab on the emote.
// Y (or the detail panel's button) adds the emote's name to the chat draft for the channel it was opened from (Seen
// channels: the emote's channel). The grid cells and the detail panel are the channel Emotes tab's.
import { el, button, toast } from '../ui.js';
import { hint } from '../input.js';
import { filterPills } from '../grid.js';
import { focusEl } from '../focus.js';
import { keyboardFor } from '../text-entry.js';
import { state } from '../state.js';
import { SevenTvSearch, SEARCH_SORTS, emoteUsage } from '../seventv-search.js';
import { emoteIndex } from '../emote-index-store.js';
import { emoteCell, fillDetail } from './channel-emotes.js';
import { isOverlay, draftAvailability, addToDraft, PROVIDER_NAMES } from '../emote-browser.js';

export const SCOPES = [{ value: '7tv', label: 'All of 7TV' }, { value: 'seen', label: 'Seen channels' }];
export const BROWSE_NOTE = 'Browse only. Use it in chat only where a channel has it enabled.';
const CHUNK = 96;
let last = { scope: '7tv', sort: 'popular', animated: false, zeroWidth: false }; // kept for the session

/** o: { query, channel: { id, login, name } | null (where Y adds), scope }. */
export function emoteSearchView({ query = '', channel = null, scope = null } = {}) {
  let search = null;
  return {
    id: 'emote-search',
    title: 'Emote search',
    destroy() { if (search) search.stop(); },
    onAction(action) { return this.act ? this.act(action) : false; },
    mount(host, nav) {
      const view = this;
      let sc = SCOPES.some((s) => s.value === scope) ? scope : last.scope;
      let list = []; // what the grid shows (7TV: the pages so far)
      let shown = 0;
      let selected = null;
      let seenGen = 0;
      const usage = new Map(); // 7TV emote id → channels count (or a Promise)

      const scopes = filterPills({ items: SCOPES, key: 'es-scope', label: 'Search in', value: sc, onPick: (v) => setScope(v) });
      const input = el('input', {
        class: 'text-input focusable es-input', type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search',
        placeholder: 'Emote name', 'aria-label': 'Emote name', maxlength: '50', dataset: { focusKey: 'es-input' },
      });
      input.value = query;
      const sorts = filterPills({ items: SEARCH_SORTS, key: 'es-sort', label: 'Sort', value: last.sort, onPick: (v) => { last.sort = v; run(true); } });
      const toggle = (label, keyName) => {
        const b = button(label, () => { last[keyName] = !last[keyName]; paintToggle(b, last[keyName]); run(true); }, { class: 'pill es-toggle', dataset: { focusKey: `es-${keyName}` } });
        paintToggle(b, last[keyName]);
        return b;
      };
      const options = el('div', { class: 'pills es-options' }, sorts.el, toggle('Animated only', 'animated'), toggle('Zero-width only', 'zeroWidth'));
      const status = el('p', { class: 'hint es-status', 'aria-live': 'polite' });
      const grid = el('div', { class: 'eb-grid es-grid', role: 'grid', 'aria-label': 'Emotes' });
      const sentinel = el('div', { class: 'eb-sentinel', 'aria-hidden': 'true' });
      const detail = el('aside', { class: 'eb-detail', 'aria-live': 'polite' });
      const hintLine = el('p', { class: 'hint eb-hint' });
      host.append(
        el('header', { class: 'view-header' }, el('h1', {}, 'Emote search'),
          channel ? el('p', { class: 'hint es-for' }, `Adding to your message for ${channel.name || channel.login}`) : null),
        el('div', { class: 'channel-toolbar es-toolbar' }, scopes.el, input),
        options,
        el('p', { class: 'es-note' }, BROWSE_NOTE),
        status,
        el('div', { class: 'eb-main' }, el('div', { class: 'eb-grid-wrap' }, grid, sentinel), detail),
        hintLine);

      search = new SevenTvSearch({ animatedPictures: state.settings.chatAnimatedEmotes !== false, onChange: (s) => { if (sc === '7tv') paint7tv(s); } });

      function setScope(v) {
        sc = last.scope = v;
        scopes.set(v);
        run(true);
      }

      function run(now = false) {
        options.hidden = sc !== '7tv';
        hintLine.replaceChildren(hint(sc === '7tv'
          ? '{Y} add to message · {LB}/{RB} scope · {B} back'
          : '{A} open the channel\'s Emotes · {Y} add to message · {LB}/{RB} scope · {B} back'));
        if (sc === '7tv') {
          search.set({ query: input.value, sort: last.sort, animated: last.animated, zeroWidth: last.zeroWidth }, { now });
        } else {
          search.stop();
          runSeen();
        }
      }

      function reset() {
        list = [];
        shown = 0;
        grid.replaceChildren();
        select(null);
      }

      function paint7tv(s) {
        if (s.page === 0) {
          reset();
          status.textContent = s.error ? `Couldn't search 7TV: ${s.error}` : 'Searching 7TV…';
          return;
        }
        list = s.items;
        if (!list.length) {
          grid.replaceChildren(el('div', { class: 'empty eb-empty' }, el('p', {}, s.query.trim() ? `No 7TV emotes match "${s.query.trim()}".` : 'No 7TV emotes.')));
          status.textContent = '';
          select(null);
          return;
        }
        if (shown === 0) { more(); select(list[0]); } else if (shown < list.length) more(); // a new page: it was asked for at the end
        status.textContent = s.error ? `Couldn't load more: ${s.error}` : s.loading ? 'Loading more…' : `${s.total.toLocaleString('en')} emotes${s.done ? '' : ', more as you scroll'}`;
      }

      async function runSeen() {
        const gen = ++seenGen;
        reset();
        const q = input.value.trim();
        const store = emoteIndex();
        if (!q) {
          const idx = await store.load();
          if (gen !== seenGen) return;
          const n = idx.channels.reduce((a, c) => a + c.emotes.length, 0);
          status.textContent = '';
          grid.append(el('div', { class: 'empty eb-empty' }, el('p', {}, n
            ? `Type a name to search ${n.toLocaleString('en')} emotes from the ${idx.channels.length} channel${idx.channels.length === 1 ? '' : 's'} you've seen.`
            : 'Channels you watch or whose Emotes tab you open are added here.')));
          return;
        }
        const hits = await store.search(q);
        if (gen !== seenGen) return;
        list = hits.map((h) => ({ ...h, overlay: isOverlay(h) }));
        if (!list.length) {
          status.textContent = '';
          grid.append(el('div', { class: 'empty eb-empty' }, el('p', {}, `No emotes match "${q}" in the channels you've seen.`)));
          return;
        }
        status.textContent = `${list.length} emote${list.length === 1 ? '' : 's'}`;
        more();
        select(list[0]);
      }

      function more() {
        const next = list.slice(shown, shown + CHUNK);
        grid.append(...next.map((e, i) => cell(e, shown + i)));
        shown += next.length;
      }

      function cell(e, i) {
        const sub = e.channel ? e.channel.name : e.author || '';
        return emoteCell(e, {
          focusKey: `es-${e.provider}-${e.id}`, i, sub,
          onClick: () => {
            if (document.body.classList.contains('input-touch') && selected !== e) { select(e); return; }
            if (e.channel) openChannel(e);
            else addToMessage(e);
          },
        });
      }

      // The focus ring's event: the detail panel follows; near the end, more cells (and 7TV's next page).
      grid.addEventListener('lurkbox-focus', (ev) => {
        const c = ev.target.closest('.eb-emote');
        if (!c) return;
        const i = Number(c.dataset.i);
        if (list[i]) select(list[i]);
        if (i >= shown - 24) nearEnd();
      });
      function nearEnd() {
        if (shown < list.length) more();
        else if (sc === '7tv') search.more();
      }
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          if (!sentinel.isConnected) { io.disconnect(); return; }
          if (entries.some((x) => x.isIntersecting) && shown > 0) nearEnd();
        }, { rootMargin: '600px 0px' });
        io.observe(sentinel);
      }

      function select(e) {
        selected = e;
        if (!e) { fillDetail(detail, null); return; }
        const facts = [];
        if (e.channel) facts.push(['Channel', e.channel.name], ...(e.channels > 1 ? [['Seen in', `${e.channels} channels`]] : []));
        else facts.push(['Used in', usageText(e.id)]);
        fillDetail(detail, e, {
          facts,
          note: el('p', { class: 'hint es-detail-note' }, e.channel ? `In ${e.channel.name}'s ${PROVIDER_NAMES[e.provider] || e.provider} set.` : BROWSE_NOTE),
          actions: [
            e.channel ? button(`Open ${e.channel.name}'s emotes`, () => openChannel(e), { class: 'es-open', dataset: { focusKey: 'es-open' } }) : null,
            button('Add to message', () => addToMessage(e), { class: 'eb-add', dataset: { focusKey: 'eb-add' } }),
          ].filter(Boolean),
        });
        if (!e.channel) loadUsage(e);
      }

      function usageText(id) {
        const n = usage.get(id);
        return typeof n === 'number' ? `${n.toLocaleString('en')} channel${n === 1 ? '' : 's'}` : n === null ? 'Unknown' : '…';
      }
      let usageTimer = null;
      function loadUsage(e) {
        clearTimeout(usageTimer);
        if (usage.has(e.id)) return;
        usageTimer = setTimeout(() => {
          usage.set(e.id, emoteUsage((...a) => fetch(...a), e.id).catch(() => null).then((n) => {
            usage.set(e.id, n);
            const dd = detail.querySelector('[data-fact="Used in"]');
            if (selected === e && dd) dd.textContent = usageText(e.id);
          }));
        }, 400);
      }

      function openChannel(e) {
        nav.openChannel({ login: e.channel.login, id: e.channel.id, name: e.channel.name, tab: 'emotes', emote: { provider: e.provider, name: e.name } });
      }

      function addToMessage(e) {
        const target = e.channel || channel;
        if (!target) { toast('Open Emote search from a channel\'s Emotes tab to add emotes to its message', 3500, 'warn'); return; }
        const why = draftAvailability(state.auth, state.settings);
        if (why === 'signed-out') { toast('Sign in to chat first', 2500, 'warn'); return; }
        if (why === 'twitch-style') { toast('Twitch chat style has its own message box. Lurkbox chat (Settings → Chat) takes emotes from here.', 3500, 'warn'); return; }
        if (addToDraft(target.login, e.name) == null) { toast('That would go over Twitch\'s 500-character limit', 2500, 'warn'); return; }
        toast(`Added to your message for ${target.name || target.login}`, 2000);
      }

      // Typing: every keyboard ends in an input event (the 7TV search waits for a pause; the index is local).
      let typing = null;
      input.addEventListener('input', () => {
        clearTimeout(typing);
        if (sc === '7tv') run();
        else typing = setTimeout(run, 150);
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        ev.stopPropagation();
        run(true);
        setTimeout(() => focusEl(grid.querySelector('.eb-emote') || input, { instant: true }), 0);
      });

      view.act = (action) => {
        if (action === 'LB' || action === 'RB') {
          const i = SCOPES.findIndex((s) => s.value === sc);
          setScope(SCOPES[(i + (action === 'RB' ? 1 : -1) + SCOPES.length) % SCOPES.length].value);
          return true;
        }
        if (action === 'A' && document.activeElement === input) {
          keyboardFor(input, { title: 'Emote name', maxLength: 50 });
          return true;
        }
        if (action === 'DOWN' && document.activeElement === input && sc === 'seen' && grid.querySelector('.eb-emote')) {
          focusEl(grid.querySelector('.eb-emote'), { instant: true });
          return true;
        }
        if (action === 'Y' && selected && document.activeElement !== input) { addToMessage(selected); return true; }
        return false;
      };

      run(true);
    },
  };
}

function paintToggle(b, on) {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
