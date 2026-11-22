// A small fetch() over Capacitor's native HTTP (CapacitorHttp): requests leave from the app, not the page, so Twitch's
// id.twitch.tv, Helix, GQL and usher answer without CORS. It covers what the shared Twitch modules use: method,
// headers, a string / URLSearchParams / JSON body, and a response with ok, status, headers.get(), text() and json().

function headerGetter(headers) {
  const map = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
  return { get: (k) => (map.has(String(k).toLowerCase()) ? map.get(String(k).toLowerCase()) : null), has: (k) => map.has(String(k).toLowerCase()) };
}

/** The request options CapacitorHttp.request() takes for a fetch(url, init). */
export function toNativeRequest(url, init = {}) {
  const headers = {};
  const src = init.headers || {};
  for (const [k, v] of (typeof src.entries === 'function' ? src.entries() : Object.entries(src))) headers[k] = String(v);
  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  const req = { url: String(url), method: String(init.method || 'GET').toUpperCase(), headers, responseType: 'text' };
  const body = init.body;
  if (body !== undefined && body !== null) {
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      // CapacitorHttp form-encodes an object itself when the content type says so.
      if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      req.data = Object.fromEntries(body.entries());
    } else if (typeof body === 'string') {
      if (!has('content-type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
      req.data = body;
      // A JSON body goes over as a value: the native side serialises it itself for application/json.
      const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')[1];
      if (/application\/json/i.test(type)) { try { req.data = JSON.parse(body); } catch { /* send as text */ } }
    } else {
      if (!has('content-type')) headers['Content-Type'] = 'application/json';
      req.data = body;
    }
  }
  return req;
}

/** A fetch-like function over CapacitorHttp.request (injected so tests can pass a mock). */
export function makeNativeFetch(nativeHttp) {
  return async function nativeFetch(url, init = {}) {
    const r = await nativeHttp.request(toNativeRequest(url, init));
    const status = Number(r.status) || 0;
    // Android may hand back JSON already parsed; text() and json() work either way.
    const data = r.data;
    const text = () => Promise.resolve(data === undefined || data === null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
    return {
      ok: status >= 200 && status < 300,
      status,
      url: r.url || String(url),
      headers: headerGetter(r.headers),
      text,
      json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
    };
  };
}
