// Demo mode's whispers: a seeded history (the desktop demo host's in-memory store), the made-up user who doesn't
// take whispers (Helix answers 403), the fake incoming whisper and the replies to what you send (install.js sends
// them over the fake EventSub socket as user.whisper.message notifications).

const MIN = 60000;

/** This demo user refuses whispers (POST /whispers → 403), to show the error. */
export const NO_WHISPERS_LOGIN = 'quietquasar';

const userByLogin = (db, login) => db.users.find((u) => u.login === login);

/** The demo history for account meId: three threads, the newest one unread. */
export function demoWhisperThreads(db, meId, now = db.now) {
  if (!meId) return [];
  const t = (login, unread, lines) => {
    const u = userByLogin(db, login);
    if (!u) return null;
    const messages = lines.map(([me, ago, text], i) => ({ id: `demo-w-${login}-${i}`, me, text, at: now - ago * MIN }));
    return { id: u.id, login: u.login, name: u.display_name, unread, at: messages[messages.length - 1].at, messages };
  };
  return [
    t('pixelmoth', 1, [
      [false, 52, 'hey! are you coming to the art stream tonight?'],
      [true, 50, 'wouldn\'t miss it, saving my points for the sketch request'],
      [false, 49, 'yesss. it\'s moths again, obviously'],
      [true, 47, 'obviously 🦋'],
      [false, 3, 'starting in 10, the lamp is ready'],
    ]),
    t('mossykeyboard', 0, [
      [false, 300, 'thanks for the raid earlier, chat loved it'],
      [true, 296, 'anytime, that build was great'],
    ]),
    t('slowfoxruns', 0, [
      [true, 1500, 'gg on the PB!'],
      [false, 1490, 'ty!! only 4 seconds off the record now'],
    ]),
  ].filter(Boolean);
}

/** The fake incoming whisper a few seconds after start, as an EventSub event to account meId. */
export function demoIncomingEvent(db, meId, n = 1) {
  const u = userByLogin(db, 'nightowlnoodles');
  const me = db.accounts.find((a) => a.id === String(meId)) || { id: String(meId), login: 'lurker', display_name: 'lurker' };
  return {
    from_user_id: u.id, from_user_login: u.login, from_user_name: u.display_name,
    to_user_id: me.id, to_user_login: me.login, to_user_name: me.display_name,
    whisper_id: `demo-in-${n}`, whisper: { text: 'psst, the noodle stream is going live in 5 🍜' },
  };
}

const REPLIES = ['haha yes', 'sounds good!', 'omw', 'see you in chat 👋', 'lol same'];

/** The recipient's reply to what you sent (the demo's "send echo"), as an EventSub event. */
export function demoReplyEvent(db, { from, to, text, n }) {
  const u = db.users.find((x) => x.id === String(to));
  if (!u || !from) return null;
  return {
    from_user_id: u.id, from_user_login: u.login, from_user_name: u.display_name,
    to_user_id: String(from.id), to_user_login: from.login, to_user_name: from.display_name || from.login,
    whisper_id: `demo-reply-${n}`, whisper: { text: /\?\s*$/.test(String(text)) ? 'good question! let me check' : REPLIES[n % REPLIES.length] },
  };
}

/** POST /whispers in demo mode (Twitch's answers): 204, or 400/403/404 like Helix, 429 past 40 new people. */
export function demoSendWhisper(db, req, ctx) {
  const q = req.query || {};
  const err = (status, message) => ({ ok: false, status, error: message, data: { error: '', status, message }, resetAt: null });
  const text = String((req.body && req.body.message) || '').trim();
  if (String(q.from_user_id) !== String(ctx.activeId)) return err(401, 'The ID in from_user_id must match the user ID in the access token.');
  if (!text) return err(400, 'The message field must not contain an empty string.');
  if (String(q.to_user_id) === String(q.from_user_id)) return err(400, 'The ID in the from_user_id and to_user_id query parameters must be different.');
  const u = db.users.find((x) => x.id === String(q.to_user_id));
  if (!u) return err(404, 'The ID in to_user_id was not found.');
  if (u.login === NO_WHISPERS_LOGIN) return err(403, 'The user that you\'re sending the whisper to doesn\'t allow whisper messages.');
  const w = db.whispersSent || (db.whispersSent = new Set());
  if (!w.has(u.id) && w.size >= 40) return { ...err(429, 'Too many requests'), resetAt: Math.ceil(((ctx.now ? ctx.now() : Date.now()) + 60000) / 1000) };
  w.add(u.id);
  return { ok: true, status: 204, data: null };
}
