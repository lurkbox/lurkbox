// Lurkbox's outline icon set for the player (drawn for Lurkbox: 24×24, 2-px round strokes like the rail icons,
// coloured by currentColor). No third-party artwork.
import { el } from './ui.js';

export const PLAYER_ICONS = {
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  'volume-low': '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  'volume-muted': '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  quality: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  chat: '<path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  'chat-off': '<path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/><path d="M3 3l18 18"/>',
  live: '<circle cx="12" cy="12" r="2.2"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5 5a9.9 9.9 0 0 0 0 14M19 5a9.9 9.9 0 0 1 0 14"/>',
  points: '<path d="M12 3.5l7.5 8.5-7.5 8.5L4.5 12z"/><path d="M12 8l3.5 4-3.5 4"/>',
  channel: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  back: '<path d="M10 6l-6 6 6 6M4.5 12H20"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  engine: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4M10.5 8.5l3.5 2-3.5 2z"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M12 9v11M4 13h16M12 9c-1.5-4-6-4-5 0M12 9c1.5-4 6-4 5 0"/>',
  poll: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
  heart: '<path d="M12 19.5C7 16 3.5 12.6 3.5 9a4.4 4.4 0 0 1 8.5-2.2A4.4 4.4 0 0 1 20.5 9c0 3.6-3.5 7-8.5 10.5z"/>',
  'heart-filled': '<path d="M12 19.5C7 16 3.5 12.6 3.5 9a4.4 4.4 0 0 1 8.5-2.2A4.4 4.4 0 0 1 20.5 9c0 3.6-3.5 7-8.5 10.5z" fill="currentColor"/>',
  side: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M14 5v14"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 9.8h0M10 9.8h0M14 9.8h0M17.5 9.8h0M8 14.2h8"/>',
  send: '<path d="M4 11.5L20 4l-6 16-2.6-6.6z"/><path d="M11.4 13.4L20 4"/>',
  quick: '<path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/><path d="M13.2 7.2l-3 4h3.6l-2.9 3.8"/>',
  emote: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 13.8a4.6 4.6 0 0 0 7.4 0"/><path d="M9.2 9.6h0M14.8 9.6h0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M6 14.5l6-6 6 6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
};

/** An inline SVG icon (aria-hidden; the control carries the label). Unknown names draw nothing. */
export function icon(name, cls = 'po-glyph') {
  return el('span', { class: cls, html: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PLAYER_ICONS[name] || ''}</svg>` });
}
