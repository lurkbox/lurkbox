// The embed iframe can grab focus (on load or when clicked). Keys would then go to the iframe and the focus ring would
// vanish, so focus is taken back to the last focused control of the app. isMouse() delays it a little for the mouse.
export function keepFocusOutOfFrames({ isMouse = () => false } = {}) {
  let lastFocused = null;
  document.addEventListener('focusin', (e) => { if (e.target.tagName !== 'IFRAME') lastFocused = e.target; });
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a.tagName !== 'IFRAME') return;
      a.blur();
      window.focus();
      if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    }, isMouse() ? 600 : 0);
  });
}
