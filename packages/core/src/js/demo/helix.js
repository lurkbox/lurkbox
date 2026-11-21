// Demo mode: answers the Helix requests the core makes (HelixRequest → HelixResult, see platform.d.ts) from the
// made-up data in ./data.js. Pure and synchronous; it never touches the network. The desktop host calls it from
// its `helix` IPC handler when LURKBOX_DEMO=1.

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
