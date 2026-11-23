// Hidden twitch.tv pages in the web session (LurkboxNative page*, TwitchHiddenPages.java): one real-size WebView per
// kind ('points', 'follow', 'drops'), off-screen, each allowed only its own twitch.tv page natively. The platform runs
// the shared sources (packages/core/src/shared/*: fixed source plus JSON-encoded data) in them and reads the answers;
// nothing here sees a cookie.

/** The default sizes (CSS px, zoom 1): the chat column as on the desktop's hidden frame; a desktop window otherwise. */
export const PAGE_SIZES = Object.freeze({ points: { width: 340, height: 720 }, follow: { width: 1280, height: 900 }, drops: { width: 1280, height: 900 } });

const parse = (r) => {
  const text = r && r.json;
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * Wraps an expression (which may be a promise) so its settled value lands in window.__lbAsync[key]; evaluateJavascript
 * itself doesn't wait for promises.
 */
export function asyncStartSource(key, source) {
  return `(() => {
    const k = ${JSON.stringify(String(key))};
    const box = window.__lbAsync || (window.__lbAsync = {});
    box[k] = { pending: true };
    Promise.resolve().then(() => (${source})).then((v) => { box[k] = { v: v === undefined ? null : v }; }, (e) => { box[k] = { e: String((e && e.message) || e).slice(0, 200) }; });
    return true;
  })()`;
}

/** Reads (and clears) a settled value: { pending } while it runs, { lost } when the page reloaded since. */
export function asyncPollSource(key) {
  return `(() => {
    const k = ${JSON.stringify(String(key))};
    const box = window.__lbAsync;
    const r = box && box[k];
    if (!r) return { lost: true };
    if (r.pending) return { pending: true };
    delete box[k];
    return r;
  })()`;
}

/**
 * @param {object} d
 * @param {object} d.native   LurkboxNative (pageOpen, pageEval, pageClose)
 * @param {(ms: number) => Promise<void>} [d.sleep]
 */
export function createHiddenPages({ native, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let seq = 0;
  const evalOnce = async (kind, source) => parse(await native.pageEval({ kind, source }));

  /** Runs a source that may resolve later; rejects after timeoutMs or when the page went away. */
  const evalAsync = async (kind, source, { timeoutMs = 30000, pollMs = 200 } = {}) => {
    const key = `k${++seq}`;
    if ((await evalOnce(kind, asyncStartSource(key, source))) !== true) throw new Error('page gone');
    for (let t = 0; t <= timeoutMs; t += pollMs) {
      await sleep(pollMs);
      const r = await evalOnce(kind, asyncPollSource(key));
      if (!r || r.lost) throw new Error('page gone');
      if (r.pending) continue;
      if ('e' in r) throw new Error(r.e);
      return r.v;
    }
    throw new Error('timed out');
  };

  return {
    /**
     * Loads url in the hidden page of this kind (replacing what it showed); resolves the page once it loaded:
     * { eval(source) (the awaited value), evalSync(source), close() }.
     */
    open: async (kind, url, { timeoutMs = 45000, ...size } = {}) => {
      const { width, height } = { ...PAGE_SIZES[kind], ...size };
      let timer = null;
      try {
        await Promise.race([
          native.pageOpen({ kind, url, width, height }),
          new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('load timed out')), timeoutMs); }),
        ]);
      } catch (e) {
        await native.pageClose({ kind }).catch(() => {});
        throw e;
      } finally { clearTimeout(timer); }
      return {
        eval: (source, opts) => evalAsync(kind, source, opts),
        evalSync: (source) => evalOnce(kind, source),
        close: () => native.pageClose({ kind }).catch(() => {}),
      };
    },
    close: (kind) => native.pageClose({ kind }).catch(() => {}),
  };
}
