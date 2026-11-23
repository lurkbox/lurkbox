// Sending in a Lurkbox chat panel: the composer at its bottom plus its two pop-overs (the emote picker and quick
// chat), anchored above the composer's buttons. Shared by the single player and multi-view's active tile.
import { el, toast } from './ui.js';
import { state, saveSettings, onAccountRemoved } from './state.js';
import { helix } from './api.js';
import { moveFocus, focusEl } from './focus.js';
import { anchorPopover } from './player-ui.js';
import { Popover } from './popover.js';
import { Composer } from './chat-composer.js';
import { EmotePicker, pickerTabs, insertEmote } from './emote-picker.js';
import { QuickChatPicker } from './quick-chat.js';
import { UserEmoteCache } from './user-emotes.js';
import { pushRecent } from '../shared/quick-chat.js';

export class ChatSending {
  /**
   * @param {object} o
   * @param {import('./chat.js').Chat} o.chat the panel's chat
   * @param {HTMLElement} o.panel the chat panel (the composer is appended to it)
   * @param {HTMLElement} o.screen where the pop-overs mount (and the box they stay inside)
   * @param {() => ({login: string, name: string, userId?: string}|null)} o.current the live channel the panel shows
   * @param {() => void} o.onLeave B in the composer
   */
  constructor({ chat, panel, screen, current, onLeave }) {
    this.chat = chat;
    this.screen = screen;
    this.current = current;
    this.composer = new Composer({
      chat,
      onSend: (text) => chat.send(text, { broadcasterId: this.broadcasterId() }),
      onLeave,
      onEmotes: (b) => this.openPicker('emotes', b),
      onQuick: (b) => this.openPicker('quick', b),
    });
    panel.append(this.composer.node);
    onAccountRemoved(() => this.composer.clear()); // a half-written message is the signed-out account's
    this.userEmotes = new UserEmoteCache((path, query) => helix(path, query));
    this.cpop = new Popover({
      scope: panel,
      focus: (n) => focusEl(n, { instant: true }),
      move: (dir, scope) => moveFocus(dir, scope),
      active: () => document.activeElement,
      mount: (node, opener) => { this.screen.append(node); this.place(node, opener); },
    });
  }

  broadcasterId() { const c = this.current(); return (c && c.userId) || undefined; }

  /** Your own Twitch emotes for this channel (Helix, cached), handed to the chat. */
  loadOwnEmotes() {
    const me = state.auth.user;
    const cur = this.current();
    if (!me || !cur || !window.lurkbox.helix) return Promise.resolve([]);
    const bid = cur.userId || this.chat.roomId || '';
    return this.userEmotes.get(me.id, bid, { animated: state.settings.chatAnimatedEmotes !== false }).then((list) => {
      if (cur === this.current()) this.chat.setOwnEmotes(list);
      return list;
    });
  }

  /** The emote picker or quick chat, above its button (pressing the button again closes it). */
  openPicker(kind, opener) {
    if (!opener || !opener.isConnected) return;
    if (this.cpop.key === kind) { this.cpop.close(); return; }
    const built = kind === 'emotes' ? this.emotePicker() : this.quickPicker();
    const node = el('div', { class: `po-pop po-ui pop-${kind}`, role: 'dialog', 'aria-label': built.title },
      el('div', { class: 'po-pop-title' }, built.title), built.body);
    this.cpop.open({
      key: kind, node, opener, initial: built.initial(), onAction: built.onAction,
      update: () => { built.update(); this.place(node, opener); },
    });
  }

  place(node, opener) {
    if (!node.isConnected || !opener) return;
    const box = this.screen.getBoundingClientRect();
    const r = opener.getBoundingClientRect();
    const { left, bottom } = anchorPopover(r, { width: node.offsetWidth, height: node.offsetHeight }, box, { margin: 12, gap: 10 });
    node.style.left = `${left}px`;
    node.style.bottom = `${bottom}px`;
    node.style.maxHeight = `${Math.max(160, box.height - bottom - 12)}px`;
  }

  /** The emote picker: Recent, your Twitch emotes, and the channel's 7TV / BTTV / FFZ emotes. A inserts. */
  emotePicker() {
    const me = state.auth.user;
    let loading = me ? 'Loading your emotes…' : 'Sign in to see your emotes.';
    if (me) {
      this.loadOwnEmotes().then(() => { loading = null; }).catch(() => { loading = 'Couldn\'t load your emotes.'; })
        .finally(() => { if (this.cpop.key === 'emotes') this.cpop.update(); });
    }
    const picker = new EmotePicker({
      tabs: () => {
        const lookup = this.chat.lookup();
        return pickerTabs({
          recents: (me && (state.settings.emoteRecents || {})[me.id]) || [],
          own: [...this.chat.ownEmotes.values()],
          sets: this.chat.index.sets,
          enabled: this.chat.prefs.providers,
          lookup: (n) => lookup.get(n),
        });
      },
      draft: () => this.composer.input.value,
      loading: (tab) => (tab === 'twitch' ? loading : null),
      onPick: (e) => this.insertEmote(e),
    });
    return picker.build();
  }

  insertEmote(e) {
    const r = insertEmote(this.composer.input.value, this.composer.caret(), e.name);
    if (!r) { toast('That would go over Twitch\'s 500-character limit', 2500, 'warn'); return; }
    this.composer.setDraft(r.text, r.caret);
    const me = state.auth.user;
    if (me) saveSettings({ emoteRecents: pushRecent(state.settings.emoteRecents, me.id, e.name) }).catch(() => {});
    if (this.cpop.isOpen) this.cpop.update();
  }

  /** Quick chat for the channel on screen (the player overlay's icon, or the composer's button). */
  quickPicker() {
    return new QuickChatPicker({
      channel: () => {
        const cur = this.current();
        if (!cur) return null;
        const id = cur.userId || this.chat.roomId;
        return id ? { id: String(id), login: cur.login, name: cur.name } : null;
      },
      lookup: () => this.chat.lookup(),
      send: (text) => this.chat.send(text, { broadcasterId: this.broadcasterId(), phrase: text }),
    }).build();
  }
}
