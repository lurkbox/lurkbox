// DOM helpers, toasts and small formatting utilities.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only used with trusted, static markup
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** A focusable button; A on the controller triggers its click handler. */
export function button(label, onClick, extra = {}) {
  const cls = ['btn', 'focusable', extra.class].filter(Boolean).join(' ');
  return el('button', { ...extra, class: cls, type: 'button', onclick: onClick }, label);
}

let toastHost = null;
export function toast(message, ms = 3500, kind = '') {
  toastHost = toastHost || document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind}`.trim(), role: 'status' }, message);
  toastHost.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
}

export function fmtViewers(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export function fmtUptime(startedAt) {
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Fills Twitch thumbnail templates: {width}x{height} and %{width}x%{height}. */
export function thumb(url, w, h, bust = false) {
  if (!url) return '';
  let u = url.replace(/%?\{width\}/g, w).replace(/%?\{height\}/g, h);
  if (bust) u += (u.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / (typeof bust === 'number' ? bust : 300000));
  return u;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.loaded) return resolve();
    const s = existing || el('script', { src });
    s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
    s.addEventListener('error', () => { s.remove(); reject(new Error(`Failed to load ${src}`)); }, { once: true });
    if (!existing) document.head.append(s);
  });
}
