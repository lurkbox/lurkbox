import { whispers } from '../whispers.js';
import { el, button, toast } from '../ui.js';
import { state, saveSettings, QUALITY_OPTIONS, RAID_DELAYS, THEMES, applyTheme, SCREEN_MARGINS, UI_SCALES } from '../state.js';
import { pickFromList, confirmDialog } from '../modal.js';
import { openKeyboard } from '../osk.js';
import { customThemeView } from './custom-theme.js';
import { playerSignIn } from '../player-login.js';
import { switchTo, addAccount, avatar } from '../accounts.js';
import { tvSignIn } from '../auth.js';
import { scheduleSteamArt, restoreSteamArt } from '../steam-art.js';
import { SORTS } from '../follows.js';
import { LIVE_SORTS } from '../../shared/sorts.js';
import { clearSearches, searchesFor } from '../../shared/search-history.js';
import { chatSettingsRows } from './settings-chat.js';
import { LAYOUT_MODES, LAYOUT_LABELS } from '../../shared/layout-mode.js';
import { subscriptionsView, blockedView } from '../social-ui.js';

function row(label, control, help) {
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-label' }, el('div', {}, label), help ? el('div', { class: 'setting-help' }, help) : null),
    el('div', { class: 'setting-control' }, control));
}

export function settingsView() {
  return {
    id: 'settings',
    title: 'Settings',
    mount(host, nav) {
      const s = state.settings;
      const defaults = state.info.defaults || {};
      const rerender = () => nav.refresh();

      const toggle = (key) => button(s[key] ? 'On' : 'Off', async () => {
        await saveSettings({ [key]: !state.settings[key] });
        rerender();
      }, { class: `toggle ${s[key] ? 'on' : ''}`, dataset: { setting: key } });

      // ---- Client ID ----
      const idInput = el('input', {
        class: 'text-input focusable client-id-input',
        type: 'text',
        value: s.clientId || '',
        placeholder: 'Twitch Client ID',
        spellcheck: 'false',
        autocomplete: 'off',
        'data-osk': 'Twitch Client ID',
      });
      const saveId = async () => {
        const v = idInput.value.trim();
        if (v === (state.settings.clientId || '')) return;
        await saveSettings({ clientId: v });
        toast(v ? 'Client ID saved' : 'Client ID cleared', 3000, v ? 'ok' : 'warn');
        rerender();
      };
      idInput.addEventListener('change', saveId);
      idInput.addEventListener('osk-done', saveId);
      idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); saveId(); } });
      const idControls = el('div', { class: 'row' },
        idInput,
        button('Keyboard', () => openKeyboard({ title: 'Twitch Client ID', value: idInput.value, onDone: (v) => { idInput.value = v; saveId(); } }), { class: 'osk-btn' }),
        defaults.clientId && s.clientId !== defaults.clientId
          ? button('Use built-in', () => { idInput.value = defaults.clientId; saveId(); })
          : null);

      // ---- Account: one sign-in covers Lurkbox (API) and the player (twitch.tv web session) ----
      const a = state.auth;
      let account = null;
      if (!a.hasClientId) {
        account = el('div', { class: 'setting-value warn' }, 'Set a Client ID first');
      } else if (!a.signedIn) {
        account = el('div', { class: 'row' },
          el('div', { class: 'setting-value' }, a.needsReauth ? 'New permissions needed' : 'Not signed in'),
          button('Sign in', () => nav.signIn(), { class: 'primary sign-in' }),
          window.lurkbox.tvSignIn ? button('Sign in with your phone instead', () => nav.phoneSignIn(), { dataset: { setting: 'phoneSignIn' } }) : null);
      }

      const fixPlayer = async (x) => {
        if (x.id !== state.auth.active) await switchTo(x.id);
        await playerSignIn();
        rerender();
      };
      const accountRow = (x) => {
        const name = x.display_name || x.login;
        const detail = el('div', { class: 'account-detail' });
        const row = el('div', { class: 'account-row' },
          el('div', { class: 'row' },
            avatar(x),
            el('div', { class: 'setting-value' }, `${x.needsSignin ? `${name}: needs sign-in` : `Signed in as ${name}`}${x.id === a.active ? ' (active)' : ''}`),
            x.id !== a.active ? button('Switch', () => switchTo(x.id).then(rerender), { dataset: { key: `switch-${x.id}` } }) : null,
            x.needsSignin
              ? button('Sign in again', () => tvSignIn({ accountId: x.id, onSuccess: rerender }), { class: 'primary' })
              : button('Sign out', () => confirmDialog({ title: `Sign out ${x.login}?`, message: 'Signs out Lurkbox and the video player for this account. It stays in the list; sign in again any time.', yes: 'Sign out', onYes: async () => { await window.lurkbox.signOut(x.id); toast('Signed out'); rerender(); } }), { class: 'sign-out' }),
            button('Remove', () => confirmDialog({ title: `Remove ${x.login}?`, message: 'Forgets this account and its player sign-in on this device.', yes: 'Remove', onYes: async () => { await window.lurkbox.removeAccount(x.id); toast('Account removed'); rerender(); } }))),
          detail);
        // Only one half broken? Say which, with a Fix button.
        statusP.then((list) => {
          const st = list.find((y) => y.id === x.id);
          if (!st || x.needsSignin) return;
          if (!st.api) {
            detail.replaceChildren(el('div', { class: 'setting-help warn' }, 'Lurkbox\'s access needs renewing.'), button('Fix', () => tvSignIn({ accountId: x.id, onSuccess: rerender })));
          } else if (!st.player && window.lurkbox.playerSessionLogin) {
            const why = st.playerLogin ? `The player is signed in as ${st.playerLogin}, so subs and Turbo apply to them.` : 'The player isn\'t signed in, so your subs and Turbo don\'t apply.';
            detail.replaceChildren(el('div', { class: 'setting-help warn' }, why), button('Fix', () => fixPlayer(x), { dataset: { setting: `fixPlayer-${x.id}` } }));
          }
        }).catch(() => {});
        return row;
      };
      const statusP = (a.accounts || []).length ? window.lurkbox.accountsStatus() : Promise.resolve([]);
      const accountsList = el('div', { class: 'accounts-list' },
        (a.accounts || []).map(accountRow),
        a.hasClientId ? button('Add account', () => addAccount(), { dataset: { setting: 'addAccount' } }) : null);

      const qLabel = (QUALITY_OPTIONS.find((q) => q.value === s.defaultQuality) || { label: s.defaultQuality }).label;
      const qualityBtn = button(qLabel, () => pickFromList({
        title: 'Default quality',
        items: QUALITY_OPTIONS,
        current: state.settings.defaultQuality,
        onPick: async (v) => { await saveSettings({ defaultQuality: v }); rerender(); },
      }), { dataset: { setting: 'defaultQuality' } });

      const delayBtn = button(`${s.raidDelay} s`, () => pickFromList({
        title: 'Raid cancel delay',
        items: RAID_DELAYS.map((d) => ({ value: d, label: d === 0 ? 'Follow immediately' : `${d} seconds` })),
        current: state.settings.raidDelay,
        onPick: async (v) => { await saveSettings({ raidDelay: v }); rerender(); },
      }), { dataset: { setting: 'raidDelay' } });

      const themeLabel = (THEMES.find((t) => t.value === s.theme) || THEMES[0]).label;
      const themeBtn = button(themeLabel, () => pickFromList({
        title: 'Theme',
        items: THEMES,
        current: state.settings.theme || 'lurkbox',
        onPreview: (v) => applyTheme(v), // live preview while moving focus
        onPick: async (v) => {
          if (v === 'custom') { nav.push(customThemeView()); return; } // saved from the editor
          applyTheme(v);
          await saveSettings({ theme: v });
          scheduleSteamArt(); // committed with A; never during the live preview
          rerender();
        },
        onCancel: () => applyTheme(state.settings.theme), // B reverts
      }), { dataset: { setting: 'theme' } });

      const steamArtBtn = button(s.steamArtSync ? 'On' : 'Off', async () => {
        const on = !state.settings.steamArtSync;
        await saveSettings({ steamArtSync: on });
        if (on) scheduleSteamArt();
        rerender();
      }, { class: `toggle ${s.steamArtSync ? 'on' : ''}`, dataset: { setting: 'steamArtSync' } });
      const restoreArtBtn = button('Restore', () => confirmDialog({
        title: 'Restore original Lurkbox art?',
        message: 'Puts back the library art Lurkbox had before it recoloured it.',
        yes: 'Restore',
        onYes: async () => {
          if (state.settings.steamArtSync) await saveSettings({ steamArtSync: false });
          await restoreSteamArt();
          rerender();
        },
      }), { dataset: { setting: 'steamArtRestore' } });

      const pickRow = (key, title, items) => {
        const cur = items.find((i) => String(i.value) === String(s[key])) || items[0];
        return button(cur.label, () => pickFromList({
          title, items, current: s[key],
          onPick: async (v) => { await saveSettings({ [key]: v }); rerender(); },
        }), { dataset: { setting: key } });
      };

      const banner = !a.hasClientId
        ? el('div', { class: 'banner warn' }, 'Lurkbox needs a Twitch Client ID before it can sign in or load anything. Enter one below, or select "Use built-in".')
        : null;

      host.append(
        el('header', { class: 'view-header' }, el('h1', {}, 'Settings')),
        banner || '',
        el('div', { class: 'settings' },
          el('h2', { class: 'section-title settings-section' }, 'Account'),
          account ? row('Account', account, 'One sign-in, here on the TV, covers Lurkbox and the video player (your subs and Turbo).') : '',
          (a.accounts || []).length ? row('Accounts', accountsList) : '',
          a.signedIn ? row('Subscriptions', button('Show', () => nav.push(subscriptionsView()), { dataset: { setting: 'subscriptions' } }), 'The channels you follow that you\'re subscribed to, with the tier and who gifted it.') : '',
          a.signedIn ? row('Blocked users', button('Manage', () => nav.push(blockedView()), { dataset: { setting: 'blockedUsers' } }), 'Everyone you\'ve blocked on Twitch, with Unblock. Block someone from their name in chat or their channel page.') : '',
          a.signedIn ? row('Hide messages from blocked users', toggle('hideBlockedChat'), 'Lurkbox chat leaves out what blocked users write.') : '',
          row('At startup', pickRow('profilePicker', 'At startup', [{ value: 'remember', label: 'Remember last account' }, { value: 'ask', label: 'Always ask who\'s watching' }])),
          row('Client ID', idControls, 'From your app at dev.twitch.tv (public client). Not a secret.'),
          el('h2', { class: 'section-title settings-section' }, 'Appearance'),
          row('Theme', themeBtn, 'Previews as you move. A keeps it, B reverts.'),
          row('Custom colours', button('Edit', () => nav.push(customThemeView()), { dataset: { setting: 'customEdit' } }), 'Pick your own background, surface, accent and text colours.'),
          window.lurkbox.steamArtApply ? row('Match Steam library artwork to theme', steamArtBtn, 'Recolours Lurkbox\'s capsule, hero, logo and icon in the Steam library when you pick a theme. This uses Steam\'s internal, undocumented client interface (enabled by Decky Loader) and may break with Steam updates. Without it, the art changes the next time Steam restarts.') : '',
          window.lurkbox.steamArtRestore ? row('Restore original Lurkbox art', restoreArtBtn, 'Puts the original library art back and turns the setting above off.') : '',
          row('Screen margin', pickRow('screenMargin', 'Screen margin', SCREEN_MARGINS), 'Space around the edges for TVs that crop the picture (overscan).'),
          row('UI scale', pickRow('uiScale', 'UI scale', UI_SCALES)),
          row('Layout', pickRow('layoutMode', 'Layout', LAYOUT_MODES.map((v) => ({ value: v, label: v === 'auto' ? 'Auto (default)' : LAYOUT_LABELS[v] }))), 'Auto picks the TV layout for a remote or controller, and the tablet or phone layout on a touchscreen.'),
          el('h2', { class: 'section-title settings-section' }, 'Player'),
          row('Player', pickRow('playerEngine', 'Player', [{ value: 'direct', label: 'Direct (default)' }, { value: 'embed', label: 'Twitch player' }]), 'Direct plays the stream itself; the official Twitch player is the automatic fallback.'),
          row('Latency', pickRow('lowLatency', 'Latency', [{ value: true, label: 'Low latency' }, { value: false, label: 'Normal' }])),
          row('Next clip', pickRow('clipAutoplay', 'Next clip', [{ value: true, label: 'Play automatically' }, { value: false, label: 'Stop after each clip' }]), 'When a clip ends, the next one of the list plays.'),
          row('Catch up automatically', toggle('autoCatchUp'), 'Plays slightly faster to stay at the live edge. Far behind? Press X to jump to live.'),
          row('Video codec', pickRow('videoCodec', 'Video codec', [{ value: 'h264', label: 'H.264 (smoothest)' }, { value: 'best', label: 'Best available' }]), 'H.264 decodes cheaply everywhere. Best available also allows AV1 and H.265 when this device decodes them in hardware. Applies to the next stream you open.'),
          row('Quality while in the background', pickRow('backgroundQuality', 'Quality while in the background', [{ value: 'same', label: 'Same' }, { value: '720', label: '720p (default)' }, { value: '480', label: '480p' }]), 'After 3 s without focus (e.g. Floater over a game), drop to this quality to leave the game more CPU and GPU. Restores when Lurkbox gets focus.'),
          row('Multi-view quality for other tiles', pickRow('multiQuality', 'Multi-view quality for other tiles', [{ value: '480', label: '480p (default)' }, { value: '720', label: '720p' }, { value: 'same', label: 'Same' }]), 'In multi-view, the tiles without the sound play at most this quality; the one with the sound uses the normal quality.'),
          row('Hardware video decoding', toggle('hwDecode'), 'VA-API. Takes effect after restarting Lurkbox.'),
          row('Default quality', qualityBtn),
          row('Auto-claim bonus points', toggle('autoClaimPoints'), 'Claims the channel-points bonus as soon as it appears, through Twitch\'s chat page in the background. Needs the TV sign-in.'),
          row('Auto-claim drops', toggle('autoClaimDrops'), 'Every 15 minutes, Lurkbox opens Twitch\'s Drops inventory page in the background and presses its Claim button for drops you have finished. Needs the TV sign-in.'),
          row('Earn channel points while watching', toggle('earnWatchPoints'), 'With the Direct player, reports the stream you\'re watching once a minute the way Twitch\'s own player does, so watch time earns points. Only while it plays on screen; never for other streams.'),
          ...chatSettingsRows({ row, rerender, pickRow }),
          el('h2', { class: 'section-title settings-section' }, 'General'),
          row('Live channels sort', pickRow('liveSort', 'Live channels sort', LIVE_SORTS.map((x) => (x.value === 'viewers' ? { ...x, label: `${x.label} (default)` } : x))), 'Order of the Live section on Following. Y there cycles it too.'),
          row('Offline channels sort', pickRow('followSort', 'Offline channels sort', SORTS.map((x) => (x.value === 'recent' ? { ...x, label: `${x.label} (default)` } : x))), 'Order of the Offline section on Following. Y there cycles it too.'),
          row('Search history', toggle('searchHistoryOn'), 'Remember your searches (per account) and show them when you open Search. Off stops remembering; what is already saved stays until you clear it.'),
          row('Clear search history', button('Clear', () => {
            const id = state.auth.user && state.auth.user.id;
            const n = searchesFor(s.searchHistory, id).length;
            if (!n) { toast('No search history for this account'); return; }
            confirmDialog({ title: 'Clear search history?', message: `${n} recent ${n === 1 ? 'search' : 'searches'} of this account.`, yes: 'Clear', onYes: async () => { await saveSettings({ searchHistory: clearSearches(state.settings.searchHistory, id) }); toast('Search history cleared'); } });
          }, { class: 'clear-search-history' }), 'Removes the recent searches of the account you are signed in with.'),
          row('Continue watching row', toggle('continueWatchingOn'), 'Videos you started but didn\'t finish, at the top of Following (per account). Off hides the row; the player still offers to resume.'),
          window.lurkbox.resumeClear ? row('Clear watch history', button('Clear', () => {
            confirmDialog({ title: 'Clear watch history?', message: 'Forgets where you stopped in every video, for this account. Continue watching starts empty.', yes: 'Clear', onYes: async () => { await window.lurkbox.resumeClear().catch(() => false); toast('Watch history cleared'); } });
          }, { class: 'clear-watch-history' }), 'Removes the saved positions of the account you are signed in with.') : null,
          window.lurkbox.whispersLoad && state.auth.signedIn ? row('Clear whispers', button('Clear', () => {
            confirmDialog({ title: 'Clear whispers?', message: 'Deletes every whisper Lurkbox has kept on this device for this account. Twitch keeps its own copy.', yes: 'Clear', onYes: async () => { await whispers().clear(); toast('Whispers cleared'); } });
          }, { class: 'clear-whispers' }), 'Whispers are kept on this device only (at most 50 conversations of 200 messages), per account.') : null,
          row('Refresh live lists', pickRow('refreshInterval', 'Refresh live lists every', [10, 15, 30, 60].map((v) => ({ value: v, label: `${v} s` })))),
          row('Hide chat and controls when Lurkbox isn\'t focused', toggle('videoOnlyUnfocused'), 'Shows just the video while another app (e.g. a game under Floater) has focus.'),
          row('Confirm before exiting', toggle('confirmExit'), 'B on the home screen exits Lurkbox.'),
          row('Navigation sounds', toggle('navSounds'), 'Quiet ticks when you move, select and go back with the controller.'),
          row('Sound volume', pickRow('navSoundVolume', 'Sound volume', [{ value: 30, label: 'Subtle' }, { value: 60, label: 'Normal' }, { value: 90, label: 'Loud' }])),
          row('Follow raids', toggle('raidFollow'), 'Switch to the raided channel when the streamer raids.'),
          row('Raid cancel delay', delayBtn, 'Time to press B before Lurkbox follows a raid.'),
          row('Skip content warnings', toggle('skipContentGate'), 'Click through the player\'s "Start watching" gate.'),
          row('Controller input when unfocused', toggle('inputWhenUnfocused'), 'Leave off so a game under Floater does not also drive Lurkbox.'),
          row('Quit Lurkbox', button('Quit', () => confirmDialog({ title: 'Quit Lurkbox?', message: '', yes: 'Quit', onYes: () => window.lurkbox.quit() })))),
        el('p', { class: 'hint version' }, `Lurkbox ${state.info.version}`));
    },
  };
}
