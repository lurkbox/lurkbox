// Playback glue: keep the screen (and the TV) on while a video plays in the page, and let it sleep otherwise.
// Media events don't bubble, so they are caught on the way down (capture) at the document.

export function anyVideoPlaying(doc) {
  return [...doc.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
}

export function installKeepScreenOn(doc, native) {
  if (!native || !native.keepScreenOn) return () => {};
  let on = null;
  const update = () => {
    const playing = anyVideoPlaying(doc);
    if (playing === on) return;
    on = playing;
    Promise.resolve(native.keepScreenOn({ on: playing })).catch(() => {});
  };
  const events = ['playing', 'play', 'pause', 'ended', 'emptied', 'abort', 'error'];
  for (const e of events) doc.addEventListener(e, update, true);
  return () => { for (const e of events) doc.removeEventListener(e, update, true); };
}
