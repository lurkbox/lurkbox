// Follow / unfollow a channel (the channel page's Follow button and the player's heart icon). Twitch's public API has
// no follow/unfollow any more, so the host presses Twitch's own button on the channel's twitch.tv page in the user's
// web session (window.lurkbox.followChannel). Whether the user follows a channel comes from Helix (isFollowing).
// Unfollow always asks first, in a Lurkbox dialog; only a "Yes" sends it. The flow is unit-tested with fakes.
import { el, button, toast as uiToast } from './ui.js';
import { confirmDialog } from './modal.js';
import { invalidateFollows, isFollowing } from './api.js';
import { icon } from './icons.js';

/** The channel page button's text. */
export function followButtonLabel(following) { return following ? 'Following' : 'Follow'; }

let busy = false;

/**
 * What a press on Follow/Following does. channel: { login, id, name }; following: what Lurkbox shows now (true,
 * false, or null when unknown). Resolves the new state (true/false), or the old one when nothing changed.
 * deps (for tests): api (window.lurkbox), confirm (confirmDialog), toast, signIn, openPage, recheck (isFollowing),
 * invalidate.
 */
export function pressFollow(channel, following, deps = {}) {
  const api = deps.api || window.lurkbox;
  const confirm = deps.confirm || confirmDialog;
  const toast = deps.toast || uiToast;
  const recheck = deps.recheck || isFollowing;
  const invalidate = deps.invalidate || invalidateFollows;
  const signIn = deps.signIn || (() => {});
  const openPage = deps.openPage || ((login) => (window.lurkbox.openChannelPage ? window.lurkbox.openChannelPage(login) : Promise.resolve(false)));
  const name = channel.name || channel.login;
  if (!api || !api.followChannel) { toast('Following isn’t available in this version of Lurkbox', 3500, 'warn'); return Promise.resolve(following); }
  if (busy) { toast('Still working on the last follow…', 2500); return Promise.resolve(following); }

  const run = async (action) => {
    busy = true;
    let r;
    try {
      r = await api.followChannel({ login: channel.login, name, action, confirmed: action === 'unfollow' });
    } catch (e) {
      r = { ok: false, reason: 'load' };
    } finally { busy = false; }
    if (r && r.ok) {
      invalidate();
      toast(r.following ? `Followed ${name}` : `Unfollowed ${name}`, 3000);
      return !!r.following;
    }
    const reason = (r && r.reason) || 'load';
    if (reason === 'no-session' || reason === 'signed-out') {
      return new Promise((resolve) => confirm({
        title: action === 'follow' ? 'Sign in to follow' : 'Sign in to unfollow',
        message: 'Following uses your twitch.tv sign-in on this TV. Sign in once and Lurkbox can follow and unfollow channels for you.',
        yes: 'Sign in with Twitch', no: 'Not now',
        onYes: () => { signIn(); resolve(following); }, onNo: () => resolve(following),
      }));
    }
    if (reason === 'busy') { toast('Still working on the last follow…', 2500); return following; }
    if (reason === 'invalid') { toast('Can’t follow this channel', 3000, 'warn'); return following; }
    // A challenge (captcha), a page that never showed the button or never flipped: let the user press it themselves.
    return new Promise((resolve) => confirm({
      title: action === 'follow' ? 'Couldn’t follow, open on twitch.tv' : 'Couldn’t unfollow, open on twitch.tv',
      message: reason === 'challenge'
        ? `Twitch wants to check it’s you. Open ${name} on twitch.tv and press ${action === 'follow' ? 'Follow' : 'Unfollow'} there.`
        : `Twitch’s page didn’t take it. Open ${name} on twitch.tv and press ${action === 'follow' ? 'Follow' : 'Unfollow'} there.`,
      yes: 'Open on twitch.tv', no: 'Cancel',
      onYes: async () => {
        await Promise.resolve().then(() => openPage(channel.login)).catch(() => {});
        invalidate();
        const now = await recheck(channel.id);
        resolve(now == null ? following : now);
      },
      onNo: () => resolve(following),
    }));
  };

  if (following === true) {
    // Never without a "Yes": even a stale "Following" only ever opens this dialog.
    return new Promise((resolve) => confirm({
      title: `Unfollow ${name}?`,
      message: `You’ll stop seeing ${name} in Following.`,
      yes: 'Unfollow', no: 'Cancel',
      onYes: () => { run('unfollow').then(resolve); },
      onNo: () => resolve(following),
    }));
  }
  // Not following, or unknown: the host only ever presses Twitch's Follow button for this (an already-followed channel
  // is reported as followed, never unfollowed).
  return run('follow');
}

/** Test hook: forget a stuck busy flag. */
export function resetFollowBusy() { busy = false; }

/**
 * The channel page's Follow/Following button (heart icon). Loads the state from Helix; hidden when it can't follow
 * (no API sign-in). nav.signIn() is the sign-in prompt's action.
 */
export function followButton(channel, nav) {
  let following = null;
  const label = el('span', {}, 'Follow');
  const b = button([icon('heart', 'po-item-icon follow-icon'), label], () => press(), { class: 'follow-btn', dataset: { focusKey: 'channel-follow' } });
  const paint = () => {
    b.classList.toggle('following', following === true);
    label.textContent = followButtonLabel(following === true);
    b.firstElementChild.replaceWith(icon(following === true ? 'heart-filled' : 'heart', 'po-item-icon follow-icon'));
    b.setAttribute('aria-label', following === true ? `Following ${channel.name || channel.login}, press to unfollow` : `Follow ${channel.name || channel.login}`);
  };
  const press = async () => {
    following = await pressFollow(channel, following, { signIn: () => nav.signIn() });
    paint();
  };
  paint();
  isFollowing(channel.id).then((f) => { if (f != null) { following = f; paint(); } });
  return b;
}
