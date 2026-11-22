// Twitch's own embedded chat page (twitch.tv/embed/<channel>/chat) in an iframe. It is the chat panel in
// "Twitch chat" style; otherwise it stays loaded off-screen while a live channel plays, so the bonus chest can be
// claimed. The platform layer (window.lurkbox.points*) scans it, claims and drives it with the controller.
import { el } from './ui.js';

const EMBED_PARENT = 'localhost';

/** Frame URL for a channel (parent must match the host the UI is served from). */
export function chatFrameUrl(login) {
  return `https://www.twitch.tv/embed/${encodeURIComponent(String(login).toLowerCase())}/chat?parent=${EMBED_PARENT}&darkpopout`;
}

export class TwitchChatFrame {
  /** @param {HTMLElement} screen the player screen (the frame is positioned inside it, never re-parented) */
  constructor(screen) {
    this.host = el('div', { id: 'twitch-chat-host', class: 'tc-hidden', 'aria-hidden': 'true' });
    screen.append(this.host);
    this.login = null;
    this.frame = null;
    this.mode = 'hidden';
  }

  /** Loads the channel's chat (or keeps it if it is already loaded). */
  open(login) {
    const l = String(login || '').toLowerCase();
    if (!l) return this.close();
    if (this.login === l && this.frame) return;
    this.close();
    this.login = l;
    // Moving an iframe in the DOM reloads it, so it is created once per channel and only repositioned with CSS.
    this.frame = el('iframe', { src: chatFrameUrl(l), title: 'Twitch chat', tabindex: '-1', allow: 'clipboard-write' });
    this.host.append(this.frame);
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(l);
  }

  close() {
    if (this.frame) this.frame.remove();
    this.frame = null;
    this.login = null;
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(null);
    this.setMode('hidden');
  }

  /** 'hidden' (off-screen, still running), 'panel' (the chat panel), 'modal' (the large rewards/predictions view). */
  setMode(mode) {
    this.mode = mode;
    this.host.className = `tc-${mode}`;
    this.host.setAttribute('aria-hidden', mode === 'hidden' ? 'true' : 'false');
    // The host zooms the frame for the TV in the panel and the large view only (the hidden one keeps a desktop layout).
    if (window.lurkbox.pointsMode) window.lurkbox.pointsMode(mode);
    if (mode === 'modal' && this.frame) this.frame.focus();
  }
}
