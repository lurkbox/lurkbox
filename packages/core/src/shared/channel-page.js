// The channel page's tabs, filters and schedule formatting (pure, unit-tested; no DOM). ES module; settings.js
// validates the saved filter choices against these lists.

/** The channel page's tabs, in order (LB/RB step through them). */
export const CHANNEL_TABS = [
  { value: 'home', label: 'Home' },
  { value: 'videos', label: 'Videos' },
  { value: 'clips', label: 'Clips' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'emotes', label: 'Emotes' },
  { value: 'about', label: 'About' },
];

/** Videos tab filters: Helix GET /videos `type`. */
export const VIDEO_FILTERS = [
  { value: 'archive', label: 'Past broadcasts' },
  { value: 'highlight', label: 'Highlights' },
  { value: 'upload', label: 'Uploads' },
];

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Clips tab periods. ms: how far back from now (null = all time). */
export const CLIP_PERIODS = [
  { value: '24h', label: '24 hours', ms: DAY },
  { value: '7d', label: '7 days', ms: 7 * DAY },
  { value: '30d', label: '30 days', ms: 30 * DAY },
  { value: 'all', label: 'All time', ms: null },
];

export function validChoice(list, value, fallback = list[0].value) {
  return list.some((x) => x.value === value) ? value : fallback;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The Helix GET /clips time window for a period: { started_at, ended_at } (RFC 3339), or {} for all time. Both ends are
 * always sent, because Helix makes a missing ended_at "started_at + one week".
 */
export function clipRange(period, now = Date.now()) {
  const p = CLIP_PERIODS.find((x) => x.value === period);
  if (!p || p.ms == null) return {};
  return { started_at: iso(now - p.ms), ended_at: iso(now) };
}

/** Seconds → "0:27", "1:02", "1:00:05" (clip and segment lengths). */
export function fmtLength(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * Helix GET /schedule `data` → the upcoming segments, soonest first: [{ id, start, end, title, category, canceled,
 * recurring }]. start/end are ms; segments that already ended (before `now`) are left out; a cancelled one stays, marked.
 */
export function scheduleSegments(data, now = Date.now()) {
  const list = (data && Array.isArray(data.segments) ? data.segments : []).map((s) => ({
    id: String(s.id || ''),
    start: Date.parse(s.start_time || ''),
    end: s.end_time ? Date.parse(s.end_time) : null,
    title: String(s.title || ''),
    category: s.category && s.category.name ? { id: String(s.category.id || ''), name: String(s.category.name) } : null,
    canceled: !!s.canceled_until,
    recurring: !!s.is_recurring,
  })).filter((s) => Number.isFinite(s.start) && (Number.isFinite(s.end) ? s.end > now : s.start > now - 4 * HOUR));
  return list.sort((a, b) => a.start - b.start);
}

/** The next segment that isn't cancelled (the Home tab's "Next stream"), or null. */
export function nextSegment(segments) {
  return (segments || []).find((s) => !s.canceled) || null;
}

/** Helix vacation ({ start_time, end_time }) as ms, or null. */
export function vacation(data) {
  const v = data && data.vacation;
  if (!v) return null;
  const start = Date.parse(v.start_time || '');
  const end = Date.parse(v.end_time || '');
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

/** "2026-03-14" in a time zone (undefined = the device's). */
function ymd(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

/**
 * When a schedule segment is, in a time zone (default: the device's): { day, time, zone, label }.
 *   day: 'Today', 'Tomorrow' or e.g. 'Mon, Mar 16' (with the year when it isn't this year's);
 *   time: '8:00 PM – 10:00 PM' (or just the start); zone: the short zone name ('UTC', 'GMT+1', 'PDT');
 *   label: '<day> · <time> <zone>'.
 * Today and Tomorrow are calendar days in that zone, not "within 24 hours".
 */
export function fmtSchedule(start, end, { now = Date.now(), timeZone, locale } = {}) {
  const at = new Date(start);
  const days = Math.round((ymd(start, timeZone) - ymd(now, timeZone)) / DAY);
  const sameYear = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(at) === new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(now));
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
    : new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }).format(at);
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
  const time = end != null && Number.isFinite(end) ? `${clock.format(at)} – ${clock.format(new Date(end))}` : clock.format(at);
  const zone = (new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(at).find((x) => x.type === 'timeZoneName') || {}).value || '';
  return { day, time, zone, label: `${day} · ${time}${zone ? ` ${zone}` : ''}` };
}

/** "1.2K followers" / "1 follower" / '' when unknown. */
export function fmtFollowers(n, short = (v) => String(v)) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return `${short(Number(n))} ${Number(n) === 1 ? 'follower' : 'followers'}`;
}
