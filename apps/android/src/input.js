// Android input glue. The TV remote's D-pad arrives in the WebView as arrow keys and OK as Enter (MainActivity maps
// DPAD_CENTER to ENTER), which the core already handles; game controllers use the Gamepad API. Only BACK needs help:
// Android delivers it to the activity, not the page. With a backButton listener registered, Capacitor no longer closes
// the app on BACK; this turns it into the core's B (Escape), so leaving the app stays behind the core's "Exit?" dialog.

/** A keydown/keyup pair for Escape (the core's B) on the window, where the core listens. */
export function pressBack(win) {
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  win.dispatchEvent(new win.KeyboardEvent('keydown', init));
  win.dispatchEvent(new win.KeyboardEvent('keyup', init));
}

/** Routes Android BACK (remote, gesture, a controller's B when the page doesn't take it) to the core's B. */
export function installBackButton(app, win) {
  if (!app || !app.addListener) return;
  app.addListener('backButton', () => pressBack(win));
}
