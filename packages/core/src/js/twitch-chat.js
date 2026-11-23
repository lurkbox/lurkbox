// Twitch's own embedded chat page (twitch.tv/embed/<channel>/chat) in an iframe. It is the chat panel in
// "Twitch chat" style; otherwise it stays loaded under the video (in the viewport, so Twitch renders it fully) while a live channel plays, so the bonus chest can be
// claimed. The platform layer (window.lurkbox.points*) scans it, claims and drives it with the controller.
import { el } from './ui.js';
import { state } from './state.js';

const EMBED_PARENT = 'localhost';

/**
 * Marks the frame that is only there for channel points (Lurkbox chat style: hidden under the video, and the rewards
 * view). The experimental chat extensions (7TV etc.) exclude URLs with it: they replace Twitch's chat UI, and without
 * Twitch's chat input row there is no points summary to read or bonus to claim.
 */
export const POINTS_MARKER = 'lurkbox=points';

/** Frame URL for a channel (parent must match the host the UI is served from); `points` adds POINTS_MARKER. */
export function chatFrameUrl(login, { points = false } = {}) {
  return `https://www.twitch.tv/embed/${encodeURIComponent(String(login).toLowerCase())}/chat?parent=${EMBED_PARENT}&darkpopout${points ? `&${POINTS_MARKER}` : ''}`;
}

export class TwitchChatFrame {
  /** @param {HTMLElement} screen the player screen (the frame is positioned inside it, never re-parented) */
  constructor(screen) {
    this.host = el('div', { id: 'twitch-chat-host', class: 'tc-hidden', 'aria-hidden': 'true' });
    screen.append(this.host);
    this.login = null;
    this.frame = null;
    this.pointsOnly = false;
    this.mode = 'hidden';
  }

  /** Loads the channel's chat (or keeps it if it is already loaded). */
  open(login) {
    const l = String(login || '').toLowerCase();
    if (!l) return this.close();
    // A host that keeps the chat page itself (AppInfo.hostPages) needs the iframe only as the visible chat panel.
    const wantFrame = !(state.info && state.info.hostPages) || state.settings.chatStyle === 'twitch';
    // Not the visible chat panel: only for channel points, so the chat extensions stay out of it.
    const pointsOnly = state.settings.chatStyle !== 'twitch';
    if (this.login === l && !!this.frame === wantFrame && (!this.frame || this.pointsOnly === pointsOnly)) return;
    this.close();
    this.login = l;
    this.pointsOnly = pointsOnly;
    if (wantFrame) {
      // Moving an iframe in the DOM reloads it, so it is created once per channel and only repositioned with CSS.
      this.frame = el('iframe', { src: chatFrameUrl(l, { points: pointsOnly }), title: 'Twitch chat', tabindex: '-1', allow: 'clipboard-write' });
      this.host.append(this.frame);
    }
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(l);
  }

  close() {
    if (this.frame) this.frame.remove();
    this.frame = null;
    this.login = null;
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(null);
    this.setMode('hidden');
  }

  /** 'hidden' (under the video, still running), 'panel' (the chat panel), 'modal' (the large rewards/predictions view). */
  setMode(mode) {
    this.mode = mode;
    this.host.className = `tc-${mode}`;
    this.host.setAttribute('aria-hidden', mode === 'hidden' ? 'true' : 'false');
    // The host zooms the frame for the TV in the panel and the large view only (the hidden one keeps a desktop layout).
    if (window.lurkbox.pointsMode) window.lurkbox.pointsMode(mode);
    if (mode === 'modal' && this.frame) this.frame.focus();
  }
}
