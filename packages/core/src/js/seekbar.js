// The player overlay's seek bar (DOM). The model comes from the player:
//   { min, max, pos, buffered: [[a, b]], label(t) → text, total → text, note → text, thumb(t) → storyboardFrame | null }
import { el } from './ui.js';

export class SeekBar {
  /** @param {{ onSeek: (t: number) => void, onPreview?: (t: number|null) => void }} opts */
  constructor({ onSeek, onPreview = () => {} }) {
    this.onSeek = onSeek;
    this.onPreview = onPreview;
    this.model = null;
    this.preview = null;
    this.cur = el('span', { class: 'po-seek-cur' });
    this.prev = el('span', { class: 'po-seek-preview' });
    this.total = el('span', { class: 'po-seek-total' });
    this.note = el('span', { class: 'po-seek-note' });
    this.buf = el('div', { class: 'po-seek-buf' });
    this.played = el('div', { class: 'po-seek-played' });
    this.head = el('div', { class: 'po-seek-head' });
    this.ghost = el('div', { class: 'po-seek-ghost' });
    this.thumbImg = el('div', { class: 'po-seek-thumb-img' });
    this.thumbTime = el('div', { class: 'po-seek-thumb-time' });
    this.thumb = el('div', { class: 'po-seek-thumb', hidden: true }, this.thumbImg, this.thumbTime);
    this.track = el('div', { class: 'po-seek-track' }, this.buf, this.played, this.ghost, this.head, this.thumb);
    this.node = el('div', { class: 'po-seek focusable', tabindex: '0', dataset: { key: 'seek', focusKey: 'po-seek' }, role: 'slider', 'aria-label': 'Seek' },
      el('div', { class: 'po-seek-times' }, this.cur, this.prev, el('span', { class: 'po-seek-gap' }), this.note, this.total),
      this.track);
    this.installMouse();
  }

  frac(t) {
    const m = this.model;
    if (!m || !(m.max > m.min)) return 0;
    return Math.min(1, Math.max(0, (t - m.min) / (m.max - m.min)));
  }

  installMouse() {
    let dragging = false;
    const at = (e) => {
      const r = this.track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      const m = this.model;
      return m ? m.min + f * (m.max - m.min) : 0;
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (!this.model) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      this.track.setPointerCapture(e.pointerId);
      this.setPreview(at(e));
    });
    this.track.addEventListener('pointermove', (e) => { if (dragging) this.setPreview(at(e)); });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      const t = at(e);
      this.setPreview(null);
      this.onSeek(t);
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', () => { dragging = false; this.setPreview(null); });
    this.track.addEventListener('click', (e) => e.stopPropagation());
  }

  setPreview(t) {
    this.preview = t;
    this.onPreview(t);
    this.render();
  }

  update(model) {
    this.model = model;
    this.render();
  }

  render() {
    const m = this.model;
    this.node.hidden = !m;
    if (!m) return;
    const pct = (f) => `${(f * 100).toFixed(3)}%`;
    this.cur.textContent = m.label(m.pos);
    this.total.textContent = m.total;
    this.note.textContent = m.note || '';
    // Buffered: the range around the playhead (or the furthest one).
    let b = null;
    for (const r of m.buffered || []) if (r[0] <= m.pos + 1 && r[1] >= m.pos) b = r;
    this.buf.style.left = pct(b ? this.frac(b[0]) : 0);
    this.buf.style.width = pct(b ? this.frac(b[1]) - this.frac(b[0]) : 0);
    this.played.style.width = pct(this.frac(m.pos));
    this.head.style.left = pct(this.frac(m.pos));
    const p = this.preview;
    const scrubbing = p != null && Number.isFinite(p);
    this.node.classList.toggle('scrubbing', scrubbing);
    this.ghost.hidden = !scrubbing;
    this.prev.textContent = scrubbing ? `→ ${m.label(p)}` : '';
    this.node.setAttribute('aria-valuetext', m.label(scrubbing ? p : m.pos));
    if (scrubbing) this.ghost.style.left = pct(this.frac(p));
    const fr = scrubbing && m.thumb ? m.thumb(p) : null;
    this.thumb.hidden = !scrubbing;
    if (scrubbing) {
      // Keep the preview inside the bar at both ends.
      const tw = this.track.clientWidth || 1;
      const half = (fr ? fr.w : this.thumbTime.offsetWidth || 60) / 2 + 4;
      this.thumb.style.left = `${Math.min(Math.max(this.frac(p) * tw, half), Math.max(half, tw - half))}px`;
      this.thumbTime.textContent = m.label(p);
      this.thumb.classList.toggle('no-image', !fr);
      if (fr) {
        Object.assign(this.thumbImg.style, {
          width: `${fr.w}px`, height: `${fr.h}px`,
          backgroundImage: `url("${fr.url}")`,
          backgroundPosition: `-${fr.x}px -${fr.y}px`,
          backgroundSize: `${fr.sheetW}px ${fr.sheetH}px`,
        });
      }
    }
  }
}
