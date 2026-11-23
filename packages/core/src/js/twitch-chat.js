// Twitch's own embedded chat page (twitch.tv/embed/<channel>/chat) in iframes. The points frame stays loaded under the
// video (in the viewport, so Twitch renders it fully) while a live channel plays, so the bonus chest can be claimed; in
// "Twitch chat" style a second frame is the visible chat panel. The platform layer (window.lurkbox.points*) scans it, claims and drives it with the controller.
import { el } from './ui.js';
import { state } from './state.js';

const EMBED_PARENT = 'localhost';

/**
 * Marks the frame that is only there for channel points (hidden under the video, and the rewards view; in both chat
 * styles). The experimental chat extensions (7TV etc.) exclude URLs with it: they replace Twitch's chat UI, and without
 * Twitch's chat input row there is no points summary to read or bonus to claim.
 */
export const POINTS_MARKER = 'lurkbox=points';

/** Frame URL for a channel (parent must match the host the UI is served from); `points` adds POINTS_MARKER. */
export function chatFrameUrl(login, { points = false } = {}) {
  return `https://www.twitch.tv/embed/${encodeURIComponent(String(login).toLowerCase())}/chat?parent=${EMBED_PARENT}&darkpopout${points ? `&${POINTS_MARKER}` : ''}`;
}

export class TwitchChatFrame {
  /**
   * @param {HTMLElement} screen the player (or multi-view) screen (the frames are positioned inside it, never re-parented)
   * @param {{ id?: string, panelId?: string }} [ids] the hosts' element ids (multi-view has its own pair)
   */
  constructor(screen, { id = 'twitch-chat-host', panelId = 'twitch-chat-panel' } = {}) {
    // The points frame (balance, claims, the rewards view): 'hidden' under the video or 'modal'.
    this.host = el('div', { id, class: 'twitch-chat-host tc-hidden', 'aria-hidden': 'true' });
    // Twitch chat style on a host without its own chat page: the visible panel (reading and typing) is a separate
    // frame, so the chat extensions can restyle it while the points frame keeps Twitch's own chat UI.
    this.panelHost = el('div', { id: panelId, class: 'twitch-chat-host tc-off', 'aria-hidden': 'true' });
    screen.append(this.host, this.panelHost);
    this.login = null;
    this.frame = null;
    this.panelFrame = null;
    this.pointsOnly = false;
    this.mode = 'hidden';
    this.panelShown = false;
  }

  /** Loads the channel's chat (or keeps it if it is already loaded). */
  open(login) {
    const l = String(login || '').toLowerCase();
    if (!l) return this.close();
    const twitchStyle = state.settings.chatStyle === 'twitch';
    // A host that keeps the chat page itself (AppInfo.hostPages) needs one iframe, only as the visible chat panel.
    const hostPages = !!(state.info && state.info.hostPages);
    const wantFrame = !hostPages || twitchStyle;
    // The visible panel gets its own frame; otherwise the one frame is the panel (hostPages) or only for points.
    const wantPanel = twitchStyle && !hostPages;
    // Not the visible chat panel: only for channel points, so the chat extensions stay out of it.
    const pointsOnly = !twitchStyle || wantPanel;
    if (this.login === l && !!this.frame === wantFrame && !!this.panelFrame === wantPanel && (!this.frame || this.pointsOnly === pointsOnly)) return;
    this.close();
    this.login = l;
    this.pointsOnly = pointsOnly;
    if (wantFrame) {
      // Moving an iframe in the DOM reloads it, so it is created once per channel and only repositioned with CSS.
      this.frame = el('iframe', { src: chatFrameUrl(l, { points: pointsOnly }), title: pointsOnly ? 'Twitch channel points' : 'Twitch chat', tabindex: '-1', allow: 'clipboard-write' });
      this.host.append(this.frame);
    }
    if (wantPanel) {
      this.panelFrame = el('iframe', { src: chatFrameUrl(l), title: 'Twitch chat', tabindex: '-1', allow: 'clipboard-write' });
      this.panelHost.append(this.panelFrame);
    }
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(l);
  }

  close() {
    if (this.frame) this.frame.remove();
    if (this.panelFrame) this.panelFrame.remove();
    this.frame = null;
    this.panelFrame = null;
    this.login = null;
    if (window.lurkbox.pointsWatch) window.lurkbox.pointsWatch(null);
    this.setMode('hidden');
  }

  /**
   * 'hidden' (under the video, still running), 'panel' (the chat panel), 'modal' (the large rewards/predictions view).
   * With a separate panel frame, 'panel' shows that frame and keeps the points frame hidden; 'modal' always uses the
   * points frame (the panel stays as it was, under the modal).
   */
  setMode(mode) {
    this.mode = mode;
    let frameMode = mode;
    if (this.panelFrame) {
      if (mode !== 'modal') this.panelShown = mode === 'panel';
      if (mode === 'panel') frameMode = 'hidden';
    } else this.panelShown = false;
    this.host.className = `twitch-chat-host tc-${frameMode}`;
    this.host.setAttribute('aria-hidden', frameMode === 'hidden' ? 'true' : 'false');
    this.panelHost.className = `twitch-chat-host ${this.panelShown ? 'tc-panel' : 'tc-off'}`;
    this.panelHost.setAttribute('aria-hidden', this.panelShown ? 'false' : 'true');
    // The host zooms the frame for the TV in the panel and the large view only (the hidden one keeps a desktop layout).
    if (window.lurkbox.pointsMode) window.lurkbox.pointsMode(mode);
    if (mode === 'modal' && this.frame) this.frame.focus();
  }
}
