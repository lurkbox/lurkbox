// Account switcher UI: rail menu, "Who's watching?" picker, add-account flow.
import { el, button, toast } from './ui.js';
import { openModal, pickFromList } from './modal.js';
import { state } from './state.js';
import { tvSignIn } from './auth.js';

function avatar(a, cls = 'acct-avatar') {
  return a && a.profile_image_url
    ? el('img', { class: cls, src: a.profile_image_url, alt: '' })
    : el('span', { class: `${cls} acct-initial` }, ((a && (a.display_name || a.login)) || '?').slice(0, 1).toUpperCase());
}
export { avatar };

export async function switchTo(id) {
  if (id === state.auth.active) return;
  const a = state.auth.accounts.find((x) => x.id === id);
  await window.lurkbox.switchAccount(id);
  toast(`Switched to ${(a && (a.display_name || a.login)) || 'account'}`, 2500, 'ok');
  if (a && a.needsSignin) tvSignIn({ accountId: id });
}

/** Same single TV sign-in, starting signed out of twitch.tv (the current account's player session is kept in its jar). */
export function addAccount() { return tvSignIn({ add: true }); }

/** The rail's account menu. */
export function accountMenu(nav) {
  const items = state.auth.accounts.map((a) => ({
    value: a.id,
    label: `${a.display_name || a.login}${a.needsSignin ? ' (sign in again)' : ''}`,
  }));
  items.push({ value: '__add', label: 'Add account' }, { value: '__manage', label: 'Manage accounts' });
  pickFromList({
    title: 'Accounts',
    items,
    current: state.auth.active,
    onPick: (v) => {
      if (v === '__add') addAccount();
      else if (v === '__manage') nav.goTop('settings');
      else switchTo(v);
    },
  });
}

/** Full-screen "Who's watching?" with big avatar tiles. Resolves once picked. */
export function whosWatching() {
  return new Promise((resolve) => {
    const tiles = el('div', { class: 'profiles' }, state.auth.accounts.map((a) => el('button', {
      class: 'focusable profile-tile', type: 'button', dataset: { id: a.id },
      onclick: async () => { m.close(); await switchTo(a.id); resolve(a.id); },
    }, avatar(a, 'profile-avatar'), el('span', { class: 'profile-name' }, a.display_name || a.login))));
    tiles.append(el('button', { class: 'focusable profile-tile profile-add', type: 'button', onclick: () => { m.close(); addAccount(); resolve(null); } },
      el('span', { class: 'profile-avatar acct-initial' }, '+'), el('span', { class: 'profile-name' }, 'Add account')));
    const m = openModal({
      title: "Who's watching?",
      class: 'profiles-modal',
      content: tiles,
      focus: `.profile-tile[data-id="${state.auth.active}"]`,
      onClose: () => resolve(state.auth.active),
    });
  });
}
