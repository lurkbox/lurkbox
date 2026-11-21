// DOM for chat message bodies: text, emote images (lazy, async-decoded, with their aspect ratio reserved so a
// late image doesn't reflow the list), zero-width overlays stacked on their base emote, badges and 7TV name paints.

/** One emote <img>. */
export function emoteImg(e, extraClass = '') {
  const img = document.createElement('img');
  img.className = `emote${extraClass ? ` ${extraClass}` : ''}`;
  img.src = e.url;
  img.alt = e.name;
  img.title = e.name;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.dataset.provider = e.provider;
  if (e.w > 0 && e.h > 0) img.style.aspectRatio = `${e.w} / ${e.h}`;
  img.addEventListener('error', () => { img.replaceWith(document.createTextNode(e.name)); }, { once: true });
  return img;
}

/** Message parts (from tokenize) → a DocumentFragment. */
export function renderParts(parts) {
  const frag = document.createDocumentFragment();
  for (const p of parts) {
    if (p.t === 'text') { frag.append(p.s); continue; }
    const fx = (p.effects || []).map((x) => `fx-${x}`).join(' ');
    if (!p.overlays || !p.overlays.length) { frag.append(emoteImg(p.emote, fx)); continue; }
    const stack = document.createElement('span');
    stack.className = `emote-stack${fx ? ` ${fx}` : ''}`;
    stack.title = [p.emote.name, ...p.overlays.map((o) => o.name)].join(' ');
    stack.append(emoteImg(p.emote));
    for (const o of p.overlays) stack.append(emoteImg(o, 'zw'));
    frag.append(stack);
  }
  return frag;
}

/** Badge images (Twitch first, then the 7TV badge). */
export function renderBadges(badges) {
  if (!badges.length) return null;
  const span = document.createElement('span');
  span.className = 'chat-badges';
  for (const b of badges) {
    const img = document.createElement('img');
    img.className = 'chat-badge';
    img.src = b.url;
    img.alt = b.title;
    img.title = b.title;
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => img.remove(), { once: true });
    span.append(img);
  }
  return span;
}

let paintSheet = null;
const paintRules = new Set();
const safeId = (id) => String(id).replace(/[^A-Za-z0-9]/g, '');

/** Adds the CSS rule for a 7TV paint once (one shared stylesheet; nothing per message). */
export function ensurePaintRule(id, css) {
  const sid = safeId(id);
  if (!sid || !css || paintRules.has(sid)) return sid;
  if (!paintSheet) {
    const style = document.createElement('style');
    style.id = 'chat-paints';
    document.head.append(style);
    paintSheet = style.sheet;
  }
  try {
    paintSheet.insertRule(`.chat-nick.paint[data-paint="${sid}"] { ${css} }`, paintSheet.cssRules.length);
    paintRules.add(sid);
  } catch { /* the browser rejected it: the plain colour stays */ }
  return sid;
}

/** Applies (or clears) a paint on a username node. */
export function applyPaint(nickNode, paintId, css) {
  if (paintId && css) {
    nickNode.dataset.paint = ensurePaintRule(paintId, css);
    nickNode.classList.add('paint');
  } else {
    nickNode.classList.remove('paint');
    delete nickNode.dataset.paint;
  }
}

const PROVIDER_LABEL = { '7tv': '7TV emote', bttv: 'BetterTTV emote', ffz: 'FrankerFaceZ emote', twitch: 'Twitch emote' };
const TIP_RADIUS = 22; // px around the touch point, so even a small badge is a 44 px tap target

/** The emote or badge nearest the point (within TIP_RADIUS), searching only the tapped message. */
export function tipTarget(msg, x, y) {
  let best = null;
  let bestD = TIP_RADIUS;
  for (const n of msg.querySelectorAll('.emote-stack, .emote:not(.emote-stack > .emote), .chat-badge')) {
    const r = n.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d <= bestD) { best = n; bestD = d; }
  }
  return best;
}

function tipText(n) {
  if (n.classList.contains('chat-badge')) return [n.alt, 'Badge'];
  if (n.classList.contains('emote-stack')) {
    const imgs = [...n.querySelectorAll('.emote')];
    return [imgs.map((i) => i.alt).join(' + '), PROVIDER_LABEL[imgs[0].dataset.provider] || 'Emote'];
  }
  return [n.alt, PROVIDER_LABEL[n.dataset.provider] || 'Emote'];
}

/**
 * Shows an emote's or badge's name on tap, long-press or click inside the chat list (one delegated listener; no
 * hover needed). The tip hides after 2.5 s or on the next tap elsewhere.
 */
export function attachChatTips(list) {
  let tip = null;
  let hideTimer = null;
  let pressTimer = null;
  const hide = () => { clearTimeout(hideTimer); if (tip) { tip.remove(); tip = null; } };
  const show = (n) => {
    hide();
    const [name, kind] = tipText(n);
    if (!name) return;
    const r = n.getBoundingClientRect();
    tip = document.createElement('div');
    tip.className = 'chat-tip';
    tip.setAttribute('role', 'tooltip');
    tip.append(name);
    const small = document.createElement('small');
    small.textContent = kind;
    tip.append(small);
    tip.style.left = `${Math.min(window.innerWidth - 16, Math.max(16, r.left + r.width / 2))}px`;
    tip.style.top = `${Math.max(48, r.top)}px`;
    document.body.append(tip);
    hideTimer = setTimeout(hide, 2500);
  };
  const at = (e) => { const msg = e.target.closest && e.target.closest('.chat-msg'); return msg ? tipTarget(msg, e.clientX, e.clientY) : null; };
  list.addEventListener('pointerdown', (e) => {
    clearTimeout(pressTimer);
    const n = at(e);
    if (n) pressTimer = setTimeout(() => show(n), 450); // long-press
  });
  list.addEventListener('pointerup', () => clearTimeout(pressTimer));
  list.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  list.addEventListener('click', (e) => { const n = at(e); if (n) show(n); else hide(); });
  // A touch long-press fires contextmenu, which Lurkbox otherwise treats as Back: on an emote it shows the tip.
  list.addEventListener('contextmenu', (e) => { const n = at(e); if (n) { e.preventDefault(); e.stopPropagation(); show(n); } });
  list.addEventListener('scroll', hide, { passive: true });
}
