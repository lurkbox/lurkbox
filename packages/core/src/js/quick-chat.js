// Quick chat: saved phrases sent with one press. The picker (from the player overlay's quick-chat icon, or from the
// composer) lists the channel's own phrases first, then the global ones; A sends (3 s per-phrase cooldown, plus the
// chat's send gate, which waits out slow mode), Y edits the highlighted phrase, X adds one to its list. Settings →
// Chat → Quick chat edits the global list and any channel's list (phraseEditor). Storage and list edits:
// ../shared/quick-chat.js.
import { el, button, toast } from './ui.js';
import { icon } from './icons.js';
import { hint } from './input.js';
import { openModal, pickFromList } from './modal.js';
import { focusEl, focusables } from './focus.js';
import { snapshotFocus, restoreFocus } from './focus-keep.js';
import { state, saveSettings } from './state.js';
import { promptText } from './text-entry.js';
import { renderParts } from './chat-render.js';
import { tokenize } from './chat-emotes.js';
import { PHRASE_COOLDOWN_MS } from './chat-send.js';
import {
  quickPhrases, phraseList, editPhrases, listOps, sanitizeQuickChat, MAX_PHRASES, MAX_PHRASE_LENGTH,
} from '../shared/quick-chat.js';

/** The saved quick chat (defaults for settings saved before it existed). */
export function quickChatSetting(s = state.settings) { return sanitizeQuickChat(s && s.quickChat); }

/** The channel last opened in the player ({ id, login, name }), for Settings → Chat → Quick chat. */
let lastChannel = null;
export function setQuickChatChannel(c) { if (c && c.id) lastChannel = { id: String(c.id), login: String(c.login || '').toLowerCase(), name: c.name || c.login || '' }; }
export function quickChatChannel() { return lastChannel; }

/** Saves one list's edit. scope 'global' | 'channel' (channel: { id, login }). */
export async function savePhraseEdit(scope, channel, edit) {
  const next = editPhrases(quickChatSetting(), scope, channel, edit);
  await saveSettings({ quickChat: next });
  return next;
}

/** Add / edit / delete through the text dialog. Resolves true when something changed. */
export async function addPhrase(scope, channel) {
  if (phraseList(quickChatSetting(), scope, channel && channel.id).length >= MAX_PHRASES) { toast(`At most ${MAX_PHRASES} phrases per list`, 2500, 'warn'); return false; }
  const r = await promptText({
    title: scope === 'global' ? 'New quick-chat phrase' : `New phrase for ${(channel && (channel.name || channel.login)) || 'this channel'}`,
    placeholder: 'e.g. gg or an emote name', maxLength: MAX_PHRASE_LENGTH,
    help: 'Emote names in the phrase show as emotes.',
  });
  if (!r || r.action !== 'save') return false;
  await savePhraseEdit(scope, channel, (l) => listOps.add(l, r.value));
  return true;
}

export async function editPhrase(scope, channel, index) {
  const list = phraseList(quickChatSetting(), scope, channel && channel.id);
  if (index < 0 || index >= list.length) return false;
  const r = await promptText({ title: 'Edit phrase', value: list[index], maxLength: MAX_PHRASE_LENGTH, deletable: true });
  if (!r) return false;
  if (r.action === 'delete') await savePhraseEdit(scope, channel, (l) => listOps.remove(l, index));
  else await savePhraseEdit(scope, channel, (l) => listOps.set(l, index, r.value));
  return true;
}

/** A phrase with its emotes drawn (lookup: an EmoteIndex-like { enabled, get(name) }). */
function phraseContent(text, lookup) {
  const span = el('span', { class: 'qc-text' });
  span.append(renderParts(tokenize(text, '', lookup, { animated: state.settings.chatAnimatedEmotes !== false })));
  return span;
}

/**
 * The quick-chat picker's body for a Popover. o: { channel: () => { id, login, name } | null, lookup: () => index,
 * send(text) → Promise<{ ok }>, close() }. build() → { title, body, initial, update, onAction }.
 */
export class QuickChatPicker {
  constructor(o) {
    this.o = o;
    this.cooling = new Map(); // phrase → timer
  }

  build() {
    this.list = el('div', { class: 'qc-list' });
    this.body = el('div', { class: 'po-pop-body qc' }, this.list,
      el('div', { class: 'po-pop-note qc-hint' }, hint('{A} send · {Y} edit · {X} add · {B} close')));
    this.update();
    return {
      title: 'Quick chat',
      body: this.body,
      initial: () => this.list.querySelector('.qc-item') || this.list.querySelector('.qc-add'),
      update: () => this.update(),
      onAction: (a) => this.onAction(a),
    };
  }

  update() {
    const ch = this.o.channel();
    const qc = quickChatSetting();
    const items = quickPhrases(qc, ch && ch.id);
    const sig = JSON.stringify([ch && ch.id, items]);
    if (this.list.dataset.sig === sig) return;
    this.list.dataset.sig = sig;
    const snap = snapshotFocus(this.list, focusables(this.list));
    const lookup = this.o.lookup();
    const item = (p) => button([phraseContent(p.text, lookup)], () => this.send(p.text), {
      class: `po-item qc-item${this.cooling.has(p.text) ? ' cooling' : ''}`, dataset: { focusKey: `qc-${p.scope}-${p.index}`, scope: p.scope, index: String(p.index), phrase: p.text },
    });
    const nodes = [];
    if (ch && ch.id) {
      nodes.push(el('div', { class: 'qc-head' }, ch.name || ch.login || 'This channel'));
      const own = items.filter((p) => p.scope === 'channel');
      for (const p of own) nodes.push(item(p));
      nodes.push(button([icon('plus', 'po-item-icon'), el('span', {}, own.length ? 'Add for this channel' : 'Add a phrase for this channel')], () => this.add('channel'),
        { class: 'po-item qc-add', dataset: { focusKey: 'qc-add-channel', scope: 'channel' } }));
      nodes.push(el('div', { class: 'qc-head' }, 'All channels'));
    }
    for (const p of items.filter((x) => x.scope === 'global')) nodes.push(item(p));
    nodes.push(button([icon('plus', 'po-item-icon'), el('span', {}, 'Add a phrase')], () => this.add('global'),
      { class: 'po-item qc-add', dataset: { focusKey: 'qc-add-global', scope: 'global' } }));
    this.list.replaceChildren(...nodes);
    restoreFocus(this.list, snap, focusables(this.list), (n) => focusEl(n, { instant: true }));
  }

  async send(text) {
    const r = await this.o.send(text);
    if (!r || !r.ok) return;
    // The phrase rests for its cooldown (dimmed), so a second press doesn't repeat it.
    clearTimeout(this.cooling.get(text));
    this.cooling.set(text, setTimeout(() => { this.cooling.delete(text); this.mark(text, false); }, PHRASE_COOLDOWN_MS));
    this.mark(text, true);
  }

  mark(text, on) {
    for (const n of this.list.querySelectorAll('.qc-item')) if (n.dataset.phrase === text) n.classList.toggle('cooling', on);
  }

  async add(scope) {
    const ch = this.o.channel();
    if (scope === 'channel' && !(ch && ch.id)) return;
    if (await addPhrase(scope, ch)) { this.update(); focusEl(this.list.querySelector('.qc-add[data-scope="' + scope + '"]') || this.list.querySelector('.qc-item'), { instant: true }); }
  }

  onAction(a) {
    const n = document.activeElement;
    const inList = n && this.list.contains(n);
    if (a === 'Y') {
      if (inList && n.classList.contains('qc-item')) {
        editPhrase(n.dataset.scope, this.o.channel(), Number(n.dataset.index)).then((changed) => { if (changed) this.update(); });
      }
      return true;
    }
    if (a === 'X') { this.add(inList && n.dataset.scope === 'channel' ? 'channel' : 'global'); return true; }
    return false;
  }
}

/**
 * Settings: the editor for one list (global, or a channel's): each phrase with Edit (A), Up, Down and Delete, and
 * "Add phrase". Changes save at once.
 */
export function phraseEditor(scope, channel = null, { onClose = null } = {}) {
  const title = scope === 'global' ? 'Quick chat · All channels' : `Quick chat · ${(channel && (channel.name || channel.login)) || channel.id}`;
  const listEl = el('div', { class: 'qc-editor' });
  const render = () => {
    const snap = snapshotFocus(listEl, focusables(listEl));
    const list = phraseList(quickChatSetting(), scope, channel && channel.id);
    const rows = list.map((text, i) => el('div', { class: 'qc-row', dataset: { focusGroup: `qc-row-${i}` } },
      button(text, () => editPhrase(scope, channel, i).then(render), { class: 'qc-edit', dataset: { focusKey: `qc-e-${i}` }, title: 'Edit' }),
      button([icon('up', 'po-item-icon')], () => savePhraseEdit(scope, channel, (l) => listOps.move(l, i, -1)).then(() => { render(); focusEl(listEl.querySelector(`[data-focus-key="qc-up-${i - 1}"]`) || listEl.querySelector(`[data-focus-key="qc-up-${i}"]`), { instant: true }); }),
        { class: 'qc-move', disabled: i === 0, 'aria-label': 'Move up', title: 'Move up', dataset: { focusKey: `qc-up-${i}` } }),
      button([icon('down', 'po-item-icon')], () => savePhraseEdit(scope, channel, (l) => listOps.move(l, i, 1)).then(() => { render(); focusEl(listEl.querySelector(`[data-focus-key="qc-down-${i + 1}"]`) || listEl.querySelector(`[data-focus-key="qc-down-${i}"]`), { instant: true }); }),
        { class: 'qc-move', disabled: i === list.length - 1, 'aria-label': 'Move down', title: 'Move down', dataset: { focusKey: `qc-down-${i}` } }),
      button('Delete', () => savePhraseEdit(scope, channel, (l) => listOps.remove(l, i)).then(render), { class: 'qc-del', dataset: { focusKey: `qc-del-${i}` } })));
    listEl.replaceChildren(
      ...(rows.length ? rows : [el('p', { class: 'setting-help' }, 'No phrases yet.')]),
      el('div', { class: 'row qc-editor-actions' },
        button(`Add phrase${list.length >= MAX_PHRASES ? ` (${MAX_PHRASES} max)` : ''}`, () => addPhrase(scope, channel).then(render), { class: 'primary', disabled: list.length >= MAX_PHRASES, dataset: { focusKey: 'qc-add' } }),
        button('Done', () => m.close(), { dataset: { focusKey: 'qc-done' } })));
    restoreFocus(listEl, snap, focusables(listEl), (n) => focusEl(n, { instant: true }));
  };
  const m = openModal({ title, class: 'qc-modal', content: el('div', {}, listEl, el('div', { class: 'osk-help' }, hint('{A} edit · Up / Down reorder · {B} close'))), focus: '.qc-edit, .qc-editor-actions .btn', onClose });
  render();
  return m;
}

/**
 * Settings → Chat → Quick chat → a channel's list: the channel last opened in the player, channels that have a list,
 * or another channel by name (looked up with Helix /users). resolveLogin(login) → { id, login, name } | null.
 */
export function pickChannelList({ resolveLogin, onClose = null }) {
  const qc = quickChatSetting();
  const items = [];
  const cur = quickChatChannel();
  if (cur) items.push({ value: `id:${cur.id}`, label: `${cur.name || cur.login} (last watched)`, channel: cur });
  for (const [id, c] of Object.entries(qc.channels)) {
    if (cur && cur.id === id) continue;
    items.push({ value: `id:${id}`, label: `${c.login || id} (${c.phrases.length})`, channel: { id, login: c.login, name: c.login } });
  }
  items.push({ value: 'other', label: 'Another channel…' });
  pickFromList({
    title: 'Quick chat for a channel',
    items,
    onPick: async (v) => {
      if (v !== 'other') { phraseEditor('channel', items.find((i) => i.value === v).channel, { onClose }); return; }
      const r = await promptText({ title: 'Channel name', placeholder: 'login, e.g. somechannel', maxLength: 25 });
      if (!r || r.action !== 'save') return;
      const login = r.value.toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{1,25}$/.test(login)) { toast('That isn\'t a Twitch channel name', 2500, 'warn'); return; }
      let ch = null;
      try { ch = await resolveLogin(login); } catch { ch = null; }
      if (!ch) { toast(`No channel called ${login}`, 2500, 'warn'); return; }
      phraseEditor('channel', ch, { onClose });
    },
  });
}
