// Demo mode: answers the Helix requests the core makes (HelixRequest → HelixResult, see platform.d.ts) from the
// made-up data in ./data.js. Pure and synchronous; it never touches the network. The desktop host calls it from
// its `helix` IPC handler when LURKBOX_DEMO=1.

import { OWN_EMOTES } from './data.js';

const ok = (data) => ({ ok: true, status: 200, data });
const list = (items) => ok({ data: items, pagination: {} });
const many = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(String));

/** @param db buildDemoData() @param req { path, query, method, body, accountId } @param ctx { activeId } */
export function demoHelix(db, req = {}, ctx = {}) {
  const path = String(req.path || '');
  const q = req.query || {};
  const method = String(req.method || 'GET').toUpperCase();
  const first = Math.min(100, Number(q.first) || 20);
  const byViewers = (a, b) => b.viewer_count - a.viewer_count;
  switch (path) {
    case '/streams/followed': {
      const set = new Set(db.liveFollowed);
      return list(db.streams.filter((s) => set.has(s.user_login)).sort(byViewers).slice(0, first));
    }
    case '/streams': {
      let s = [...db.streams];
      if (q.user_id != null) { const ids = many(q.user_id); s = s.filter((x) => ids.includes(x.user_id)); }
      if (q.user_login != null) { const l = many(q.user_login).map((x) => x.toLowerCase()); s = s.filter((x) => l.includes(x.user_login)); }
      if (q.game_id != null) { const g = many(q.game_id); s = s.filter((x) => g.includes(x.game_id)); }
      return list(s.sort(byViewers).slice(0, first));
    }
    case '/channels/followed':
      if (q.broadcaster_id != null) { const f = db.follows.filter((x) => x.broadcaster_id === String(q.broadcaster_id)); return ok({ data: f, total: f.length, pagination: {} }); }
      return ok({ data: db.follows.slice(0, first), total: db.follows.length, pagination: {} });
    case '/games/top':
      return list(db.games.slice(0, first));
    case '/games': {
      const ids = many(q.id);
      return list(db.games.filter((g) => ids.includes(g.id)));
    }
    case '/users': {
      let u = [];
      if (q.id != null) { const ids = many(q.id); u = db.users.filter((x) => ids.includes(x.id)); }
      if (q.login != null) { const l = many(q.login).map((x) => x.toLowerCase()); u = u.concat(db.users.filter((x) => l.includes(x.login))); }
      if (q.id == null && q.login == null) u = db.users.filter((x) => x.id === ctx.activeId);
      return list(u);
    }
    case '/search/categories': {
      const term = String(q.query || '').toLowerCase().trim();
      return list(term ? db.games.filter((g) => g.name.toLowerCase().includes(term)).slice(0, first) : []);
    }
    case '/search/channels': {
      const term = String(q.query || '').toLowerCase().replace(/\s+/g, '');
      const live = new Map(db.streams.map((s) => [s.user_id, s]));
      const hits = db.users.filter((u) => !db.accounts.some((a) => a.id === u.id) && term && (u.login.includes(term) || u.display_name.toLowerCase().includes(term)));
      return list(hits.slice(0, first).map((u) => {
        const s = live.get(u.id);
        const g = s ? { name: s.game_name, id: s.game_id } : (db.gameOf.get(u.id) || { name: '', id: '' });
        return {
          id: u.id, broadcaster_login: u.login, display_name: u.display_name, broadcaster_language: 'en',
          game_id: g.id, game_name: g.name, is_live: !!s, title: s ? s.title : '', tags: [],
          thumbnail_url: u.profile_image_url, started_at: s ? s.started_at : '',
        };
      }));
    }
    case '/videos': {
      let v = db.videos;
      if (q.id != null) { const ids = many(q.id); return list(v.filter((x) => ids.includes(x.id))); }
      if (q.user_id != null) { const id = String(q.user_id); v = v.filter((x) => x.user_id === id); }
      if (q.type && q.type !== 'all') v = v.filter((x) => x.type === q.type);
      return list([...v].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, first));
    }
    case '/chat/badges/global':
      return list(db.badges);
    case '/chat/badges':
      return list([]); // the channel has no badges of its own; the global ones apply
    case '/chat/emotes/user': {
      // Your emotes, two to a page (so the core's pagination runs), with a template on the demo's own pictures.
      if (String(q.user_id) !== String(ctx.activeId)) return { ok: false, status: 400, error: 'Bad Request', data: { message: 'user_id must be the signed-in user' }, resetAt: null };
      const all = OWN_EMOTES.map(([name, type]) => ({ id: name, name, emote_type: type, emote_set_id: `demo-${type}`, owner_id: type === 'globals' ? '0' : String(q.broadcaster_id || '0'), format: ['static'], scale: ['1.0', '2.0'], theme_mode: ['dark', 'light'] }));
      const start = Number(q.after) || 0;
      const next = start + 2 < all.length ? String(start + 2) : null;
      return ok({ data: all.slice(start, start + 2), template: `${db.media('img/emote/')}{{id}}.svg`, pagination: next ? { cursor: next } : {} });
    }
    case '/chat/messages': {
      // Sending: accepted, except the same text twice within 30 s (Twitch's msg_duplicate rule). The renderer's fake IRC
      // echoes accepted messages back (install.js), like the real anonymous chat connection does.
      if (method !== 'POST') return { ok: false, status: 404, error: 'Not Found', data: null, resetAt: null };
      const b = req.body || {};
      const text = String(b.message || '').trim();
      if (!text || String(b.sender_id) !== String(ctx.activeId)) return { ok: false, status: 400, error: 'Bad Request', data: { message: 'The sender must be the signed-in user.' }, resetAt: null };
      const now = ctx.now ? ctx.now() : Date.now();
      const sent = db.sent || (db.sent = { n: 0, last: null });
      if (sent.last && sent.last.text === text && sent.last.to === String(b.broadcaster_id) && now - sent.last.at < 30000) {
        return ok({ data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_duplicate', message: 'Your message is identical to the one you sent within the last 30 seconds.' } }] });
      }
      sent.n += 1;
      sent.last = { text, to: String(b.broadcaster_id), at: now };
      return ok({ data: [{ message_id: `demo-msg-${sent.n}`, is_sent: true, drop_reason: null }] });
    }
    case '/eventsub/subscriptions':
      if (method === 'POST') {
        const b = req.body || {};
        return { ok: true, status: 202, data: { data: [{ id: `demo-sub-${(b.condition && b.condition.from_broadcaster_user_id) || 0}`, status: 'enabled', type: b.type, version: '1', condition: b.condition, transport: b.transport }], total: 1 } };
      }
      if (method === 'DELETE') return { ok: true, status: 204, data: null };
      return list([]);
    default:
      return { ok: false, status: 404, error: `demo mode has no ${path}`, data: null, resetAt: null };
  }
}
