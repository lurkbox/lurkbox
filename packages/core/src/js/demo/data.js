// Demo mode data (LURKBOX_DEMO=1 on desktop): a made-up signed-in account, channels, categories, videos and chat
// people. Everything here is invented; no real streamers, games or images. Pure and deterministic (fixed clock,
// seeded randomness), so the README screenshots come out the same every run. Shared by the desktop host (the fake
// Helix API in the main process) and the renderer (the fake chat). ES module, no DOM.

/** The demo's "now": Sat 14 Mar 2026, 20:00:05 UTC. The renderer's clock is pinned to it in demo mode. */
export const DEMO_NOW = Date.UTC(2026, 2, 14, 20, 0, 5);

/** mulberry32: a small seeded PRNG. Returns () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a string (seeds per-channel images). */
export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** Generic categories (genres, not real games). `art` picks the box-art motif. */
export const GAMES = [
  { id: '9101', name: 'Cozy Farming', art: 'farm', hue: 95 },
  { id: '9102', name: 'Retro Speedruns', art: 'speed', hue: 15 },
  { id: '9103', name: 'Just Chatting', art: 'chat', hue: 330 },
  { id: '9104', name: 'Space Trucking', art: 'space', hue: 225 },
  { id: '9105', name: 'Pixel Platformers', art: 'pixel', hue: 45 },
  { id: '9106', name: 'Music & Synths', art: 'music', hue: 285 },
  { id: '9107', name: 'Roguelike Dungeons', art: 'dungeon', hue: 0 },
  { id: '9108', name: 'Puzzle Hour', art: 'puzzle', hue: 175 },
  { id: '9109', name: 'Art Studio', art: 'art', hue: 20 },
  { id: '9110', name: 'Kart Racing', art: 'race', hue: 200 },
  { id: '9111', name: 'Ocean Survival', art: 'ocean', hue: 190 },
  { id: '9112', name: 'City Builders', art: 'city', hue: 35 },
  { id: '9113', name: 'Tabletop Tales', art: 'dice', hue: 260 },
  { id: '9114', name: 'Rhythm Games', art: 'rhythm', hue: 310 },
  { id: '9115', name: 'Monster Taming', art: 'monster', hue: 120 },
  { id: '9116', name: 'Science & Tech', art: 'tech', hue: 160 },
];
const G = Object.fromEntries(GAMES.map((g) => [g.name, g]));

// [login, display name, category, title, viewers, uptime in minutes]. Followed by the demo account.
const LIVE_FOLLOWED = [
  ['mossykeyboard', 'MossyKeyboard', 'Cozy Farming', 'Turnip season! Building the greenhouse, chill vibes all evening', 2841, 134],
  ['slowfoxruns', 'SlowFoxRuns', 'Retro Speedruns', 'Any% practice, trying for sub-25 before bedtime', 1207, 71],
  ['captaincumulus', 'CaptainCumulus', 'Space Trucking', 'Hauling crates to the outer moons, night shift', 864, 252],
  ['pixelmoth', 'PixelMoth', 'Pixel Platformers', 'Blind run, world 6. No spoilers please!', 15420, 48],
  ['nightowlnoodles', 'NightOwlNoodles', 'Just Chatting', 'Ramen review night and your questions', 3310, 96],
  ['brambleandbard', 'BrambleAndBard', 'Tabletop Tales', 'Campaign night, session 41: the lighthouse', 692, 188],
  ['lanternlynx', 'LanternLynx', 'Roguelike Dungeons', 'Daily seed, then viewer challenge runs', 2088, 37],
  ['quietquasar', 'QuietQuasar', 'Music & Synths', 'Making a lo-fi track from scratch, live', 451, 162],
  ['orbitalotter', 'OrbitalOtter', 'Ocean Survival', 'Day 30 on the raft. The shark has a name now', 1736, 209],
  ['teaandtiles', 'TeaAndTiles', 'Puzzle Hour', 'Sunday puzzles with a big pot of tea', 318, 22],
  ['papercranecrafts', 'PaperCraneCrafts', 'Art Studio', 'Painting a stormy harbour, all welcome', 529, 115],
  ['turbopancake', 'TurboPancake', 'Kart Racing', 'Cup races with chat, first to 10 wins', 978, 63],
];
// Live, not followed (Browse, categories, search).
const LIVE_OTHER = [
  ['sundialsam', 'SundialSam', 'City Builders', 'Rebuilding the whole riverside district', 7240, 301],
  ['midnightmuffin', 'MidnightMuffin', 'Just Chatting', 'Baking at midnight, come hang out', 5112, 142],
  ['knightofkettles', 'KnightOfKettles', 'Roguelike Dungeons', 'Hardest difficulty or bust', 4380, 88],
  ['glimmergecko', 'GlimmerGecko', 'Monster Taming', 'Shiny hunting, 4000 encounters and counting', 3925, 410],
  ['rhythmraccoon', 'RhythmRaccoon', 'Rhythm Games', 'Expert charts only tonight', 2610, 55],
  ['circuitsparrow', 'CircuitSparrow', 'Science & Tech', 'Soldering a tiny weather station', 1488, 179],
  ['nightshadenomad', 'NightshadeNomad', 'Space Trucking', 'Long haul across the nebula, no fast travel', 1342, 233],
  ['pixelpicnic', 'PixelPicnic', 'Pixel Platformers', 'Hundred percent run, collecting every berry', 1105, 140],
];
// Offline follows: [login, display name, last category, days since last live].
const OFFLINE = [
  ['velvetvoxel', 'VelvetVoxel', 'Pixel Platformers', 1], ['dustydragonfly', 'DustyDragonfly', 'Cozy Farming', 2],
  ['grumpygarnet', 'GrumpyGarnet', 'Roguelike Dungeons', 1], ['harborhaze', 'HarborHaze', 'Ocean Survival', 3],
  ['inkyiris', 'InkyIris', 'Art Studio', 5], ['jollyjunebug', 'JollyJunebug', 'Just Chatting', 2],
  ['kelpforestkid', 'KelpForestKid', 'Ocean Survival', 8], ['lofilighthouse', 'LofiLighthouse', 'Music & Synths', 1],
  ['marbleminotaur', 'MarbleMinotaur', 'Tabletop Tales', 12], ['nebulanectar', 'NebulaNectar', 'Space Trucking', 4],
  ['nightjarnotes', 'NightjarNotes', 'Music & Synths', 6], ['pixelpilgrim', 'PixelPilgrim', 'Retro Speedruns', 9],
  ['quillandquest', 'QuillAndQuest', 'Tabletop Tales', 3], ['rustyrobin', 'RustyRobin', 'Science & Tech', 15],
  ['saffronsails', 'SaffronSails', 'City Builders', 7], ['thimblethunder', 'ThimbleThunder', 'Kart Racing', 2],
  ['umbrellaunicorn', 'UmbrellaUnicorn', 'Puzzle Hour', 21], ['waffleworks', 'WaffleWorks', 'Just Chatting', 30],
  ['yarnyeti', 'YarnYeti', 'Art Studio', 11], ['zigzagzephyr', 'ZigZagZephyr', 'Rhythm Games', 4],
];

/** The signed-in demo accounts ("Who's watching?" shows all three). */
const ACCOUNTS = [
  ['1000001', 'lurker', 'lurker'],
  ['1000002', 'couchcritter', 'CouchCritter'],
  ['1000003', 'sofaspud', 'SofaSpud'],
];

/** Fake device-code shown on the phone sign-in screen. */
export const DEMO_DEVICE_CODE = 'ABCD-EFGH';

/**
 * Builds the demo database. media(path) turns a demo media path ("img/avatar/x.svg") into a URL the host serves.
 * Returns plain objects shaped like Helix responses.
 */
export function buildDemoData({ media = (p) => `demo-media/${p}` } = {}) {
  const r = rng(20260314);
  const users = [];
  const streams = [];
  const byLogin = new Map();
  let nextId = 7100001;
  const mkUser = (login, display, i) => {
    const u = {
      id: String(nextId++), login, display_name: display, type: '', broadcaster_type: i % 3 === 0 ? 'partner' : 'affiliate',
      description: `Hi, I'm ${display}. This is a made-up channel for the Lurkbox demo.`,
      profile_image_url: media(`img/avatar/${login}.svg`), offline_image_url: media(`img/vod/${login}~99-1600x400.svg`), view_count: 0,
      created_at: iso(DEMO_NOW - (400 + Math.floor(r() * 2000)) * DAY),
    };
    users.push(u);
    byLogin.set(login, u);
    return u;
  };
  const mkStream = ([login, display, game, title, viewers, upMin], i) => {
    const u = mkUser(login, display, i);
    const g = G[game];
    streams.push({
      id: String(41000000000 + i * 7919), user_id: u.id, user_login: login, user_name: display,
      game_id: g.id, game_name: g.name, type: 'live', title, viewer_count: viewers,
      started_at: iso(DEMO_NOW - upMin * MIN - 5000), language: 'en',
      thumbnail_url: media(`img/thumb/${login}-{width}x{height}.svg`), tag_ids: [], tags: ['English', 'Demo'], is_mature: false,
    });
  };
  LIVE_FOLLOWED.forEach((s, i) => mkStream(s, i));
  LIVE_OTHER.forEach((s, i) => mkStream(s, i + LIVE_FOLLOWED.length));
  const offline = OFFLINE.map(([login, display, game, days], i) => ({ u: mkUser(login, display, i + 40), game: G[game], days }));
  const accounts = ACCOUNTS.map(([id, login, display]) => ({
    id, login, display_name: display, profile_image_url: media(`img/avatar/${login}.svg`), needsSignin: false,
  }));
  for (const a of accounts) users.push({ ...a, type: '', broadcaster_type: '', description: '', view_count: 0, created_at: iso(DEMO_NOW - 900 * DAY) });

  // Follows: the 12 live ones and the 20 offline ones, followed over the last two years.
  const followed = [...LIVE_FOLLOWED.map(([l]) => byLogin.get(l)), ...offline.map((o) => o.u)];
  const follows = followed.map((u, i) => ({
    broadcaster_id: u.id, broadcaster_login: u.login, broadcaster_name: u.display_name,
    followed_at: iso(DEMO_NOW - (20 + i * 23) * DAY),
  }));

  // Videos per channel: the archive of the current broadcast (live rewind), then past broadcasts and highlights.
  const videos = [];
  const vodTitles = ['Late night session', 'Chill stream with chat', 'The big attempt', 'Sunday special', 'Q&A and catch-up', 'Marathon part 2', 'Trying something new', 'Community night'];
  let vodId = 2200000001;
  for (const u of users) {
    if (accounts.some((a) => a.id === u.id)) continue;
    const s = streams.find((x) => x.user_id === u.id);
    const off = offline.find((o) => o.u.id === u.id);
    const game = s ? G[s.game_name] : off.game;
    if (s) {
      const up = Math.floor((DEMO_NOW - Date.parse(s.started_at)) / 1000);
      videos.push(mkVideo(vodId++, u, s.title, s.started_at, up, 'archive', s.id, game, 0));
    }
    const startDays = off ? off.days : 1;
    for (let k = 0; k < 8; k++) {
      const dur = 3600 + Math.floor(r() * 4 * 3600);
      const at = DEMO_NOW - (startDays + k * 2) * DAY - Math.floor(r() * 6) * 3600 * 1000 - dur * 1000;
      const type = k === 3 || k === 6 ? 'highlight' : k === 5 && hash(u.login) % 2 === 0 ? 'upload' : 'archive';
      const t = `${vodTitles[(k + u.login.length) % vodTitles.length]}${type === 'highlight' ? ' (best bits)' : type === 'upload' ? ' (edited)' : ''}`;
      videos.push(mkVideo(vodId++, u, t, iso(at), type === 'highlight' ? 300 + Math.floor(r() * 900) : dur, type, null, game, k + 1));
    }
  }
  function mkVideo(id, u, title, createdAt, durSec, type, streamId, game, k) {
    return {
      id: String(id), stream_id: streamId, user_id: u.id, user_login: u.login, user_name: u.display_name,
      title, description: '', created_at: createdAt, published_at: createdAt,
      url: '', thumbnail_url: media(`img/vod/${u.login}~${k}-%{width}x%{height}.svg`), viewable: 'public',
      view_count: 120 + Math.floor(r() * 9000), language: 'en', type, duration: helixDuration(durSec), muted_segments: null,
      game_name: game ? game.name : '',
    };
  }

  // Clips per channel: made from its broadcasts (video_id + vod_offset), spread over the last 60 days, by various
  // made-up viewers. Ids are Twitch-style slugs.
  const clips = [];
  const clipTitles = ['That jump though', 'Chat called it', 'The perfect moment', 'Wait for it…', 'Absolutely clean', 'Unexpected visitor', 'We did it!', 'Speechless', 'Clutch save', 'The laugh', 'How?!', 'Best part of the stream'];
  const clippers = ['tinylurker', 'couchpotato42', 'mossfan', 'snackbreak', 'nightviewer', 'tealeaf', 'pixelpal', 'quietfan'];
  const pascal = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  for (const u of users) {
    if (accounts.some((a) => a.id === u.id)) continue;
    const own = videos.filter((v) => v.user_id === u.id && v.type === 'archive');
    const n = 6 + (hash(u.login) % 7);
    for (let k = 0; k < n; k++) {
      const v = own[(k + 1) % Math.max(1, own.length)];
      // Two clips from the last day, a few from this week, the rest over two months.
      const ago = k < 2 ? (2 + k * 5) * 3600 * 1000 : k < 5 ? (1 + k) * DAY + Math.floor(r() * DAY) : (8 + k * 6) * DAY + Math.floor(r() * DAY);
      const words = ['Brave', 'Sleepy', 'Lucky', 'Fuzzy', 'Mighty', 'Gentle', 'Shiny', 'Clever'];
      const slug = `${pascal(words[(k + u.login.length) % words.length])}${pascal(u.login.slice(0, 6))}Clip${k}-demo${hash(`${u.login}${k}`) % 100000}`;
      const g = s0(u.id);
      clips.push({
        id: slug, url: '', embed_url: '', // no real links in demo data
        broadcaster_id: u.id, broadcaster_name: u.display_name, creator_id: String(8800000 + k), creator_name: clippers[(k + hash(u.login)) % clippers.length],
        video_id: v ? v.id : '', game_id: g ? g.id : '', language: 'en', title: clipTitles[(k + hash(u.login)) % clipTitles.length],
        view_count: Math.floor(40 + r() * (k < 5 ? 2400 : 18000)), created_at: iso(DEMO_NOW - ago),
        thumbnail_url: media(`img/vod/${u.login}~${20 + k}-480x272.svg`), duration: [15, 30, 45][Math.floor(r() * 3)], // the demo has MP4s of these lengths (demo-media.js)
        vod_offset: v ? 60 + Math.floor(r() * 3000) : null, is_featured: k === 0,
      });
    }
  }
  function s0(uid) {
    const s = streams.find((x) => x.user_id === uid);
    if (s) return G[s.game_name];
    const off = offline.find((o) => o.u.id === uid);
    return off ? off.game : null;
  }

  // Schedules: most channels stream on set weekdays (weekly segments for the next three weeks); every fourth has none (from the second)
  // (Helix answers 404), one is on a break.
  const schedules = new Map();
  users.forEach((u, i) => {
    if (accounts.some((a) => a.id === u.id) || i % 4 === 1) return;
    const g = s0(u.id);
    const hourUtc = 14 + (hash(u.login) % 8); // 14:00–21:00 UTC
    const days = [1 + (i % 3), 3 + (i % 3), 6];
    const segments = [];
    for (let week = 0; week < 3; week++) {
      for (const d of days) {
        const start = Date.UTC(2026, 2, 14 + d + week * 7, hourUtc, 0, 0);
        segments.push({
          id: `demo-seg-${u.id}-${week}-${d}`, start_time: iso(start), end_time: iso(start + (2 + (d % 3)) * 3600 * 1000),
          title: d === 6 ? 'Marathon night' : `${g ? g.name : 'Stream'} night`, canceled_until: null,
          category: g ? { id: g.id, name: g.name } : null, is_recurring: true,
        });
      }
    }
    schedules.set(u.id, {
      segments, broadcaster_id: u.id, broadcaster_name: u.display_name, broadcaster_login: u.login,
      vacation: i % 9 === 5 ? { start_time: iso(DEMO_NOW - DAY), end_time: iso(DEMO_NOW + 6 * DAY) } : null,
    });
  });
  const followers = new Map(users.map((u) => [u.id, 120 + (hash(`${u.login}:f`) % 240000)]));

  const games = GAMES.map((g) => ({ id: g.id, name: g.name, box_art_url: media(`img/boxart/${g.id}-{width}x{height}.svg`), igdb_id: '' }));
  // Top categories by viewers (live viewers summed, offline-only categories after them).
  const gameViewers = new Map(GAMES.map((g) => [g.id, 0]));
  for (const s of streams) gameViewers.set(s.game_id, gameViewers.get(s.game_id) + s.viewer_count);
  games.sort((a, b) => gameViewers.get(b.id) - gameViewers.get(a.id) || a.name.localeCompare(b.name));

  return {
    now: DEMO_NOW, accounts, users, streams, follows, videos, games, media, clips, schedules, followers,
    liveFollowed: LIVE_FOLLOWED.map(([l]) => l),
    lastLive: new Map(offline.map((o) => [o.u.id, DEMO_NOW - o.days * DAY])),
    gameOf: new Map(offline.map((o) => [o.u.id, o.game])),
    badges: demoBadges(media),
  };
}

/** Seconds → Helix duration ("3h2m1s"). */
export function helixDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
}

/** Chat badges drawn for the demo (images/badges in images.js), in Helix /chat/badges shape. */
export const BADGES = [
  ['broadcaster', '1', 'Broadcaster'], ['moderator', '1', 'Moderator'], ['vip', '1', 'VIP'],
  ['subscriber', '0', 'Subscriber'], ['subscriber', '6', '6-Month Subscriber'], ['subscriber', '12', '1-Year Subscriber'],
  ['bits', '100', 'cheer 100'], ['artist', '1', 'Artist'],
];
function demoBadges(media) {
  const sets = new Map();
  for (const [set, v, title] of BADGES) {
    if (!sets.has(set)) sets.set(set, { set_id: set, versions: [] });
    const url = media(`img/badge/${set}-${v}.svg`);
    sets.get(set).versions.push({ id: v, title, image_url_1x: url, image_url_2x: url, image_url_4x: url, description: title });
  }
  return [...sets.values()];
}

/**
 * The emotes drawn for the demo chat: [name, provider, zeroWidth]. Pictures in images.js (emoteSvg). Only 7TV and
 * FrankerFaceZ: their API responses carry the image URL, while BetterTTV's image host is fixed in the core.
 */
/** The demo accounts' own "Twitch" emotes (Helix /chat/emotes/user in demo mode): [name, emote type]. */
export const OWN_EMOTES = [['lurkerHi', 'subscriptions'], ['lurkerLove', 'subscriptions'], ['lurkerGG', 'follower'], ['lurkerZzz', 'globals']];

export const EMOTES = [
  ['lurkWave', '7tv', false], ['lurkCozy', '7tv', false], ['boxHype', '7tv', false], ['peekbox', '7tv', false],
  ['partyHat', '7tv', true], ['teaSip', 'ffz', false], ['wowie', '7tv', false], ['hehe', 'ffz', false],
  ['gigaGG', 'ffz', false], ['heartbeat', 'ffz', false], ['rainyday', 'ffz', false], ['clapclap', 'ffz', false],
];
