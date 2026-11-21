// Test helpers for the core package (fetch mocks only: core code never touches the file system).
export const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch mock driven by a list of [matcher, responder] routes; records calls. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ url: u, method: init.method || 'GET', body, headers: init.headers || {} });
    for (const [match, respond] of routes) {
      if (typeof match === 'string' ? u.includes(match) : match(u, init, body)) return respond(u, init, body, calls);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  fn.calls = calls;
  return fn;
}
