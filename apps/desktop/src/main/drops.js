'use strict';
// Twitch Drops: the inventory scan, auto-claim loop and names are shared with the other hosts (see
// packages/core/src/shared/drops.js). Here only the desktop's part: the Drops section frames Twitch's inventory page in
// Lurkbox's own window, which twitch.tv refuses, so its frame and headers are recognised and adjusted.
const shared = require('@lurkbox/core/src/shared/drops.js');

/**
 * Is this webRequest (onHeadersReceived details) the Drops section's own frame: a sub-frame of Lurkbox's window whose
 * parent is the window's top frame showing Lurkbox's page (pageUrl), not a frame nested deeper inside another site?
 */
function isAppDropsFrame(d, { webContentsId, pageUrl }) {
  if (!d || d.resourceType !== 'subFrame' || d.webContentsId !== webContentsId) return false;
  let parent = null;
  try { parent = d.frame && d.frame.parent; } catch { return false; }
  if (!parent || parent.parent) return false;
  try { return String(parent.url).startsWith(pageUrl); } catch { return false; }
}

/**
 * Response headers for the inventory page in the Drops view's iframe: twitch.tv refuses framing (X-Frame-Options,
 * CSP frame-ancestors), so those two are removed for this page only; every other header is kept as is.
 */
function allowFraming(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === 'x-frame-options') continue;
    if (key === 'content-security-policy') {
      const list = (Array.isArray(v) ? v : [v]).map((p) => String(p).split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')).filter((p) => p.trim());
      if (list.length) out[k] = list;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const { INVENTORY_URL, SELECTORS, CLAIM_TEXT, NAV_OPTIONS, isInventoryUrl, isDropsPageUrl, cleanName, scanSource, scanInventory, DropsClaimer } = shared;
module.exports = { INVENTORY_URL, SELECTORS, CLAIM_TEXT, NAV_OPTIONS, isInventoryUrl, isDropsPageUrl, isAppDropsFrame, allowFraming, cleanName, scanSource, scanInventory, DropsClaimer };
