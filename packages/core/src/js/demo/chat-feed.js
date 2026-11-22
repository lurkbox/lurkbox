// Demo mode chat: invented chatters and a deterministic script of messages with the demo's own emotes and badges,
// as Twitch IRC lines, so the real chat code (chat.js) parses and renders them unchanged. Pure, no DOM.
import { rng, hash } from './data.js';

/** [display name, colour, badges tag, user id]. The ids are what the fake 7TV events paint. */
export const CHATTERS = [
  ['SnackGoblin', '#FF8A66', 'moderator/1,subscriber/12', '8000001'],
  ['quietpebble', '#3FB5C4', 'subscriber/6', '8000002'],
  ['MapleMochi', '#FFB547', 'vip/1,subscriber/12', '8000003'],
  ['sock_wizard', '#9BE37A', '', '8000004'],
  ['TinyTornado', '#E44FA8', 'subscriber/0', '8000005'],
  ['blanketfort', '#B48CFF', 'subscriber/6,bits/100', '8000006'],
  ['CaffeineCrab', '#FF5F6D', '', '8000007'],
  ['ploppy_turnip', '#6DFFCF', 'subscriber/12', '8000008'],
  ['DuskWanderer', '#FFD34D', 'artist/1', '8000009'],
  ['noodle_arms', '#7FD18B', '', '8000010'],
  ['SirSnoozealot', '#5FA8FF', 'moderator/1', '8000011'],
  ['velcro_owl', '#FFA07A', 'subscriber/0', '8000012'],
];
/** Chatters whose names get a 7TV paint from the fake EventAPI. */
export const PAINTED = ['8000003', '8000006'];

const LINES = [
  'hi everyone lurkWave',
  'that jump was so clean boxHype boxHype',
  'just got here, what did I miss?',
  'teaSip cozy stream tonight',
  'wowie',
  'gigaGG',
  'lurkCozy lurkCozy lurkCozy',
  'the music on this stream is always so good heartbeat',
  'hehe that was close',
  'peekbox partyHat',
  'raining here too rainyday',
  'clapclap clapclap',
  'how long have you been playing this one?',
  'chat is so wholesome today lurkCozy',
  'back from making tea teaSip',
  'lurkWave from the couch',
  'GG! gigaGG',
  'peekbox just lurking, have a good stream',
  'no way wowie',
  'first time catching this live heartbeat',
  'that sound effect hehe',
  'boxHype partyHat',
  'can we get a lurkWave for the new folks',
  'take your time, no rush',
];

/** Tag value escaping for IRC (spaces → \s). */
const tagEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s');

/** The n-th demo chat message for a channel, as an IRC PRIVMSG line (deterministic). */
export function chatLine(channel, roomId, n) {
  const r = rng(hash(channel) + n * 7919);
  const [nick, color, badges, uid] = CHATTERS[Math.floor(r() * CHATTERS.length)];
  const text = LINES[(n * 5 + Math.floor(r() * 3)) % LINES.length];
  const tags = {
    'badge-info': '', badges, color, 'display-name': nick, emotes: '', id: `demo-${channel}-${n}`,
    mod: badges.includes('moderator') ? '1' : '0', 'room-id': roomId, 'tmi-sent-ts': String(1773518400000 + n * 1500), 'user-id': uid,
  };
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${tagEsc(v)}`).join(';');
  const login = nick.toLowerCase();
  return `@${tagStr} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${channel} :${text}`;
}

/** Your own message as the IRC echo the anonymous chat connection gets after a Helix send. */
export function ownLine({ channel, roomId, user, text, id, color = '#9BE37A', badges = '' }) {
  const login = String(user.login || 'lurker').toLowerCase();
  const tags = {
    'badge-info': '', badges, color, 'display-name': user.display_name || login, emotes: '', id: String(id || ''),
    mod: '0', 'room-id': String(roomId), 'tmi-sent-ts': String(Date.now()), 'user-id': String(user.id),
  };
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${tagEsc(v)}`).join(';');
  return `@${tagStr} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${channel} :${text}`;
}

/** What the fake IRC server answers on JOIN: the join, the room state and a backlog of `backlog` messages. */
export function joinLines(channel, roomId, backlog = 24) {
  const out = [
    `:justinfan12345!justinfan12345@justinfan12345.tmi.twitch.tv JOIN #${channel}`,
    `@emote-only=0;followers-only=10;r9k=0;room-id=${roomId};slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #${channel}`, // followers-only: the composer's note
  ];
  for (let i = 0; i < backlog; i++) out.push(chatLine(channel, roomId, i));
  return out;
}
