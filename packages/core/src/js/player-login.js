// "Sign in to the player too": optional twitch.tv web session for subs/Turbo in the embed.
import { el, button, toast } from './ui.js';
import { openModal, confirmDialog } from './modal.js';

let afterLogin = () => {};
export function onPlayerLogin(fn) { afterLogin = fn; }

export async function playerSignIn() {
  toast('Opening twitch.tv sign-in…', 2500);
  const r = await window.lurkbox.playerSessionLogin();
  if (!r.ok) { toast('Player sign-in cancelled', 2500); return r; }
  toast(`Player signed in as ${r.login || 'your account'}`, 3500, 'ok');
  if (r.mismatch) {
    confirmDialog({
      title: 'Different accounts',
      message: r.mismatch,
      yes: 'Keep',
      no: 'Sign out of the player',
      onYes: () => {},
    });
    // "Sign out of the player" is the dialog's cancel button:
    const no = document.querySelector('.modal .confirm .btn:not(.primary)');
    if (no) no.addEventListener('click', () => window.lurkbox.playerSessionSignOut().then(() => afterLogin()));
  }
  afterLogin();
  return r;
}

/** Offered after the phone sign-in, which leaves the player signed out. */
export function offerPlayerSignIn() {
  const m = openModal({
    title: 'Sign in on this TV too?',
    content: el('div', { class: 'confirm' },
      el('p', {}, 'Signing in with your phone covers Lurkbox, but not the video player. Your subs and Turbo only apply when the player is signed in to twitch.tv too. This opens the twitch.tv login page here once.'),
      el('div', { class: 'row' },
        button('Sign in to the player', () => { m.close(); playerSignIn(); }, { class: 'primary' }),
        button('Not now', () => m.close()))),
  });
  return m;
}
