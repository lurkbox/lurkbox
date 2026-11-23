// Demo mode: answers the Helix requests the core makes (HelixRequest → HelixResult, see platform.d.ts) from the
// made-up data in ./data.js. Pure and synchronous; it never touches the network. The desktop host calls it from
// its `helix` IPC handler when LURKBOX_DEMO=1.

import { OWN_EMOTES } from './data.js';
import { CHATTERS } from './chat-feed.js';

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
      if (q.id != null) {
        // Like Helix: the videos found; 404 when none of the ids exists (a deleted VOD).
        const ids = many(q.id);
        const found = v.filter((x) => ids.includes(x.id));
        return found.length ? list(found) : { ok: false, status: 404, error: 'Not Found', data: { message: 'videos not found' }, resetAt: null };
      }
      if (q.user_id != null) { const id = String(q.user_id); v = v.filter((x) => x.user_id === id); }
      if (q.type && q.type !== 'all') v = v.filter((x) => x.type === q.type);
      const sorted = [...v].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const start = Number(q.after) || 0;
      const next = start + first < sorted.length ? String(start + first) : null;
      return ok({ data: sorted.slice(start, start + first), pagination: next ? { cursor: next } : {} });
    }
    case '/clips': {
      if (method === 'POST') return demoCreateClip(db, q, ctx);
      // By views, like Helix; a cursor of plain offsets.
      if (q.id != null) { const ids = many(q.id); return list(db.clips.filter((c) => ids.includes(c.id))); }
      let c = db.clips.filter((x) => x.broadcaster_id === String(q.broadcaster_id));
      if (q.started_at) { const a = Date.parse(q.started_at); const b = q.ended_at ? Date.parse(q.ended_at) : a + 7 * 86400000; c = c.filter((x) => { const t = Date.parse(x.created_at); return t >= a && t <= b; }); }
      c = [...c].sort((a, b) => b.view_count - a.view_count);
      const start = Number(q.after) || 0;
      const next = start + first < c.length ? String(start + first) : null;
      return ok({ data: c.slice(start, start + first), pagination: next ? { cursor: next } : {} });
    }
    case '/schedule': {
      const sch = db.schedules.get(String(q.broadcaster_id));
      if (!sch) return { ok: false, status: 404, error: 'Not Found', data: { message: 'segments were not found' }, resetAt: null };
      const start = Number(q.after) || 0;
      const next = start + first < sch.segments.length ? String(start + first) : null;
      return ok({ data: { ...sch, segments: sch.segments.slice(start, start + first) }, pagination: next ? { cursor: next } : {} });
    }
    case '/channels/followers':
      return ok({ data: [], total: db.followers.get(String(q.broadcaster_id)) || 0, pagination: {} });
    case '/channels': {
      const ids = many(q.broadcaster_id);
      return list(db.users.filter((u) => ids.includes(u.id)).map((u) => {
        const s = db.streams.find((x) => x.user_id === u.id);
        const g = s ? { id: s.game_id, name: s.game_name } : (db.gameOf.get(u.id) || { id: '', name: '' });
        return { broadcaster_id: u.id, broadcaster_login: u.login, broadcaster_name: u.display_name, broadcaster_language: 'en', game_id: g.id, game_name: g.name, title: s ? s.title : '', delay: 0, tags: ['English', 'Demo', 'Cozy'], content_classification_labels: [], is_branded_content: false };
      }));
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
    case '/chat/emotes': {
      // A channel's own emotes (the channel page's Emotes tab → Twitch): two subscriber tiers and a follower emote.
      const id = String(q.broadcaster_id || '');
      if (!db.users.some((u) => u.id === id)) return { ok: false, status: 400, error: 'Bad Request', data: { message: 'broadcaster_id is required' }, resetAt: null };
      const tiers = { lurkerHi: '1000', lurkerLove: '2000', lurkerGG: '' };
      const data = OWN_EMOTES.filter(([name]) => name in tiers).map(([name, type]) => ({ id: name, name, tier: tiers[name], emote_type: type, emote_set_id: `demo-${type}`, format: ['static'], scale: ['1.0', '2.0'], theme_mode: ['dark', 'light'] }));
      return ok({ data, template: `${db.media('img/emote/')}{{id}}.svg` });
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
    case '/subscriptions/user': {
      // One channel at a time, like Helix; 404 when you aren't subscribed.
      if (String(q.user_id) !== String(ctx.activeId)) return { ok: false, status: 403, error: 'Forbidden', data: { message: 'user_id must match the token' }, resetAt: null };
      const sub = ctx.activeId === db.accounts[0].id ? db.subs.get(String(q.broadcaster_id)) : null;
      return sub ? list([sub]) : { ok: false, status: 404, error: 'Not Found', data: { message: `${ctx.activeId} has no subscription to ${q.broadcaster_id}` }, resetAt: null };
    }
    case '/users/blocks': {
      if (method === 'GET') {
        if (String(q.broadcaster_id) !== String(ctx.activeId)) return { ok: false, status: 400, error: 'Bad Request', data: { message: 'broadcaster_id must match the token' }, resetAt: null };
        // Two to a page, so the core's pagination runs.
        const start = Number(q.after) || 0;
        const next = start + 2 < db.blocks.length ? String(start + 2) : null;
        return ok({ data: db.blocks.slice(start, start + 2), pagination: next ? { cursor: next } : {} });
      }
      const id = String(q.target_user_id || '');
      if (!id) return { ok: false, status: 400, error: 'Bad Request', data: { message: 'Missing target_user_id' }, resetAt: null };
      if (method === 'PUT') {
        if (!db.blocks.some((b) => b.user_id === id)) {
          const u = db.users.find((x) => x.id === id);
          const c = CHATTERS.find((x) => x[3] === id);
          const name = u ? u.display_name : c ? c[0] : id;
          db.blocks.unshift({ user_id: id, user_login: u ? u.login : String(name).toLowerCase(), display_name: name });
        }
        return { ok: true, status: 204, data: null };
      }
      if (method === 'DELETE') { db.blocks = db.blocks.filter((b) => b.user_id !== id); return { ok: true, status: 204, data: null }; }
      return { ok: false, status: 404, error: 'Not Found', data: null, resetAt: null };
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

/** Demo channels where clipping is off (Helix answers 403). */
export const CLIPS_OFF = ['teaandtiles'];

/**
 * POST /clips in demo mode: the live channel's clip, added to its clips at once (Twitch takes ~15 s to process a real
 * one). 404 when the channel isn't live, 403 where clips are off, 429 after 5 clips within a minute.
 */
function demoCreateClip(db, q, ctx) {
  const now = ctx.now ? ctx.now() : Date.now();
  const id = String(q.broadcaster_id || '');
  const s = db.streams.find((x) => x.user_id === id);
  const u = db.users.find((x) => x.id === id);
  if (!s || !u) return { ok: false, status: 404, error: 'Not Found', data: { message: 'The broadcaster must be broadcasting live.' }, resetAt: null };
  if (CLIPS_OFF.includes(u.login)) return { ok: false, status: 403, error: 'Forbidden', data: { message: 'The broadcaster has disabled clips on their channel.' }, resetAt: null };
  const made = db.made || (db.made = []);
  const recent = made.filter((t) => now - t < 60000);
  if (recent.length >= 5) return { ok: false, status: 429, error: 'Too Many Requests', data: { message: 'Too many clips.' }, resetAt: Math.ceil((recent[0] + 60000) / 1000) };
  made.push(now);
  const me = db.users.find((x) => x.id === String(ctx.activeId)) || { id: '0', display_name: 'you' };
  const n = made.length;
  const slug = `Demo${u.display_name}Clip${n}-made${(now % 100000).toString(36)}`;
  const archive = db.videos.find((v) => v.stream_id === s.id);
  const up = Math.max(30, Math.floor((now - Date.parse(s.started_at)) / 1000));
  db.clips.push({
    id: slug, url: '', embed_url: '', broadcaster_id: u.id, broadcaster_name: u.display_name, creator_id: me.id, creator_name: me.display_name,
    video_id: archive ? archive.id : '', game_id: s.game_id, language: 'en', title: s.title, view_count: 1, created_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    thumbnail_url: db.media(`img/vod/${u.login}~${40 + n}-480x272.svg`), duration: 30, vod_offset: archive ? up - 30 : null, is_featured: false,
  });
  return { ok: true, status: 202, data: { data: [{ id: slug, edit_url: `https://clips.twitch.tv/${slug}/edit` }] } };
}
