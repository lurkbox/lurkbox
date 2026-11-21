// The Drops section: Twitch's own Drops Inventory page (twitch.tv/drops/inventory) in the signed-in twitch.tv session,
// in a large frame with the controller hint below it (never over the page). The host zooms the page for the TV and runs
// the shared controller navigation inside it (window.lurkbox.dropsPad); B leaves a dialog first, then goes to the rail.
import { el, button } from '../ui.js';
import { hint } from '../input.js';
import { state } from '../state.js';
import { Y } from '../input-core.js';
import { INVENTORY_URL, dropsScreen, dropsPadKey } from '../drops.js';

function ago(at) {
  if (!at) return null;
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function dropsView() {
  let stage = null;
  let frame = null;
  return {
    id: 'drops',
    title: 'Drops',
    destroy() { if (frame) window.lurkbox.dropsClose().catch(() => {}); },
    onAction(action) {
      if (!stage || document.activeElement !== stage) return false;
      if (action === Y) { frame.src = INVENTORY_URL; return true; }
      const key = dropsPadKey(action);
      if (!key) return false;
      if (key === 'b') {
        window.lurkbox.dropsPad('b').then((r) => { if (r !== 'back' && document.activeElement === stage) this.nav.focusRail(); }).catch(() => this.nav.focusRail());
        return true;
      }
      window.lurkbox.dropsPad(key).catch(() => {});
      return true;
    },
    async mount(host, nav) {
      this.nav = nav;
      host.append(el('header', { class: 'view-header' }, el('h1', {}, 'Drops')));
      const supported = !!window.lurkbox.dropsStatus;
      const st = supported ? await window.lurkbox.dropsStatus().catch(() => null) : null;
      const screen = dropsScreen({ supported, signedIn: !!(st && st.signedIn) });
      if (screen === 'unsupported') {
        host.append(el('div', { class: 'empty' }, el('h2', {}, 'Drops aren’t available here'), el('p', {}, 'This version of Lurkbox can’t show the Drops inventory.')));
        return;
      }
      if (screen === 'signin') {
        host.append(el('div', { class: 'empty drops-signin' },
          el('h2', {}, 'Sign in to see your Drops'),
          el('p', {}, 'The Drops inventory is Twitch’s own page, shown with your twitch.tv sign-in. Signing in on the TV also lets Lurkbox claim finished drops for you.'),
          button('Sign in with Twitch', () => nav.signIn(), { class: 'primary big drops-signin-btn' })));
        return;
      }
      const auto = state.settings.autoClaimDrops !== false;
      const checked = ago(st.lastCheckAt);
      host.querySelector('.view-header').append(
        el('span', { class: 'refresh-status drops-status' }, auto ? `Auto-claim on${checked ? ` · checked ${checked}` : ''}` : 'Auto-claim off (Settings → Player)'),
        hint('{Y} reload'));
      frame = el('iframe', {
        src: INVENTORY_URL, title: 'Twitch Drops inventory', tabindex: '-1',
        // No top navigation or popups: the page stays inside its frame.
        sandbox: 'allow-scripts allow-same-origin allow-forms',
      });
      stage = el('div', { class: 'drops-stage focusable', tabindex: '0', 'aria-label': 'Drops inventory', dataset: { focusKey: 'drops-stage' } }, frame);
      // Focus on the frame (from the rail, or at the start): start the page's own navigation.
      // Leaving it (B, the rail, another section) stops it, so its focus ring is only there while the frame has focus.
      stage.addEventListener('focus', () => { window.lurkbox.dropsOpen().catch(() => {}); });
      stage.addEventListener('blur', () => { window.lurkbox.dropsClose().catch(() => {}); });
      host.append(stage, el('div', { class: 'drops-hint-strip' }, hint('D-pad move · {A} select · {B} back', 'points-hint')));
    },
  };
}
