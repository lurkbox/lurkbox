// Demo mode's VOD chat replay: VideoCommentsByOffsetOrCursor answers made up from the demo chatters and lines
// (chat-feed.js), one comment every 2.5 s of video, 25 to a page, so the host's real parser and the page's replay run
// offline. Deterministic per video. Pure; used by apps/desktop/src/main/demo.js.
import { CHATTERS, LINES } from './chat-feed.js';
import { rng, hash } from './data.js';

const EVERY = 2.5;
const PAGE = 25;

function node(videoId, n) {
  const r = rng(hash(String(videoId)) + n * 104729);
  const [nick, color, badges, uid] = CHATTERS[Math.floor(r() * CHATTERS.length)];
  const text = LINES[(n * 7 + Math.floor(r() * 5)) % LINES.length];
  return {
    id: `demo-vc-${videoId}-${n}`,
    contentOffsetSeconds: Math.floor(n * EVERY),
    commenter: { id: uid, login: nick.toLowerCase(), displayName: nick },
    message: {
      fragments: [{ text, emote: null }],
      userBadges: badges ? badges.split(',').map((b) => { const [setID, version] = b.split('/'); return { setID, version }; }) : [],
      userColor: color,
    },
  };
}

/** The GQL answer for commentsBody({ videoId, offset | cursor }) of a video `durationSec` long, owned by roomId. */
export function demoComments({ videoId, offset = null, cursor = null, durationSec = 3600, roomId = '7100001' }) {
  const last = Math.floor(durationSec / EVERY);
  const start = cursor ? Number(String(cursor).replace(/^demo-/, '')) || 0 : Math.ceil(Math.max(0, Number(offset) || 0) / EVERY);
  const end = Math.min(last, start + PAGE);
  const edges = [];
  for (let n = start; n < end; n++) edges.push({ cursor: `demo-${n + 1}`, node: node(videoId, n) });
  return { data: { video: { id: String(videoId), creator: { id: String(roomId) }, comments: { edges, pageInfo: { hasNextPage: end < last } } } } };
}
