// Settings → Chat: third-party emotes, animation, 7TV cosmetics, and the experimental real browser extensions.
import { el, button, toast } from '../ui.js';
import { saveSettings, previewSettings, state, onState } from '../state.js';
import { TWITCH_CHAT_SIZES, twitchChatZoom } from '../../shared/tv-zoom.js';
import { ChatControls, resetChatLayoutPatch } from '../chat-controls.js';
import { chatHeightApplies } from '../../shared/chat-layout.js';
import { confirmDialog } from '../modal.js';
import { tw } from '../api.js';
import { phraseEditor, pickChannelList, quickChatSetting } from '../quick-chat.js';

/** What the chat controls need to know about the screen (also used by the player's chat pop-over). */
export function chatEnv(direct = true) {
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const b = document.body.classList;
  const heightApplies = chatHeightApplies({
    mode: b.contains('layout-phone') ? 'phone' : b.contains('layout-tablet') ? 'tablet' : 'tv',
    touch: b.contains('touch-ui'), portrait: b.contains('orient-portrait'),
  });
  return { windowWidth: window.innerWidth, screenHeight: window.screen && window.screen.height, remPx, direct, heightApplies };
}

const LAYOUT_HELP = {
  chatStyle: 'Lurkbox chat is the controller-first panel with 7TV, BetterTTV and FrankerFaceZ emotes. Twitch chat is Twitch\'s own chat page, signed in with your twitch.tv session: channel points, predictions and polls work there.',
  chatTextSize: 'Lurkbox chat text and emotes.',
  twitchChatSize: 'Zoom for Twitch chat style (Twitch\'s own chat, channel-points rewards, predictions and polls), which Twitch draws at desktop size. Auto fits the screen like the TV sign-in.',
  chatWidth: 'Share of the screen. Beside the video, the video shrinks to make room (the chat takes at most half the screen).',
  chatSide: '',
  chatHeight: 'Share of the player\'s height. Beside the video, the video keeps its size; over the video, a chat at the bottom moves up while the controls are shown. The phone layout and touch portrait ignore it.',
  chatVPos: 'Where a chat shorter than the player sits.',
  chatBgOpacity: 'Lurkbox chat beside the video.',
  chatOverlay: 'Lurkbox chat on top of the stream, see-through, instead of beside it. Not for Twitch chat: Twitch\'s chat and player pause when something covers them.',
  chatOverlayOpacity: '',
};

/** The toggles in this section, in order (also used by the unit tests). Missing settings count as on, except extensions. */
export const CHAT_TOGGLES = [
  { key: 'chatEmotes7tv', label: '7TV emotes', help: 'Emotes from 7tv.app for this channel and 7TV\'s global set.' },
  { key: 'chatEmotesBttv', label: 'BetterTTV emotes', help: 'Emotes from betterttv.com.' },
  { key: 'chatEmotesFfz', label: 'FrankerFaceZ emotes', help: 'Emotes from frankerfacez.com.' },
  { key: 'chatAnimatedEmotes', label: 'Animated emotes', help: 'Off shows the first frame. Saves a little CPU while a game runs.' },
  { key: 'chat7tvCosmetics', label: '7TV name paints and badges', help: 'Coloured names and badges of chatters who use 7TV, plus their personal emotes.' },
];

/** Settings → Chat → Twitch chat size: Auto (the TV rule; the label shows the current value) or a fixed zoom. */
export function twitchChatSizeItems(settings, screenHeight) {
  const auto = Math.round(twitchChatZoom({ ...settings, twitchChatSize: 'auto' }, screenHeight) * 100);
  return [{ value: 'auto', label: `Auto (${auto}%)` }, ...TWITCH_CHAT_SIZES.map((v) => ({ value: v, label: `${v}%` }))];
}

export function chatSettingOn(settings, key) {
  return key === 'chatExtensions' ? settings[key] === true : settings[key] !== false;
}

const extLine = (x) => {
  const v = x.installed ? `${x.installed}${x.latest && x.latest !== x.installed ? ` (update: ${x.latest})` : ''}` : 'not installed';
  const st = x.status === 'failed' ? `failed: ${x.error || 'unknown error'} (disabled)` : x.loaded ? 'loaded' : x.status;
  return `${x.name}: ${v}, ${st}`;
};

/** Builds the section's rows with the settings view's own row() helper. */
export function chatSettingsRows({ row, rerender, pickRow }) {
  const s = state.settings;
  const toggle = (key) => {
    const on = chatSettingOn(s, key);
    return button(on ? 'On' : 'Off', async () => {
      await saveSettings({ [key]: !chatSettingOn(state.settings, key) });
      rerender();
    }, { class: `toggle ${on ? 'on' : ''}`, dataset: { setting: key } });
  };

  const plainToggle = (key) => button(s[key] ? 'On' : 'Off', async () => {
    await saveSettings({ [key]: !state.settings[key] });
    rerender();
  }, { class: `toggle ${s[key] ? 'on' : ''}`, dataset: { setting: key } });

  const rows = [el('h2', { class: 'section-title settings-section' }, 'Chat')];
  rows.push(row('Chat on by default', plainToggle('chatDefault')));
  // Layout: the same controls (and settings keys) as the chat pop-over in the player. Sliders preview at once and
  // save after a pause; the pop-over and this section follow each other through state.settings.
  const controls = new ChatControls({
    settings: s,
    env: () => chatEnv(state.settings.playerEngine !== 'embed'),
    onChange: (patch, { live }) => {
      if (live) previewSettings(patch);
      else saveSettings(patch).then(rerender);
    },
    wrap: (spec, control, note) => {
      const extra = spec.key === 'twitchChatSize'
        ? button('Auto', () => saveSettings({ twitchChatSize: 'auto' }).then(rerender), { class: 'cc-auto', dataset: { setting: 'twitchChatSizeAuto' } })
        : spec.key === 'chatWidth'
          ? button('Auto', () => saveSettings({ chatWidth: 'auto' }).then(rerender), { class: 'cc-auto', dataset: { setting: 'chatWidthAuto' } })
          : null;
      const label = spec.key === 'twitchChatSize' ? 'Twitch chat size' : spec.key === 'chatTextSize' ? 'Text size' : spec.key === 'chatStyle' ? 'Chat style' : spec.label;
      const r = row(label, el('div', { class: 'row cc-setting', dataset: { focusGroup: spec.key } }, control, extra), LAYOUT_HELP[spec.key] || spec.key !== 'chatWidth' ? el('span', {}, LAYOUT_HELP[spec.key] || '', ' ', spec.key === 'chatWidth' ? null : note) : null);
      r.dataset.chatControl = spec.key;
      return r;
    },
  });
  rows.push(...controls.nodes);
  const off = onState((what) => {
    if (what !== 'settings') return;
    if (!rows[0].isConnected) { off(); return; } // the view was re-mounted or left
    controls.update(state.settings);
  });
  rows.push(row('Reset chat layout', button('Reset', () => confirmDialog({
    title: 'Reset chat layout?',
    message: 'Text size, width, side, height, position, background and "over the video" go back to their defaults.',
    yes: 'Reset',
    onYes: async () => { await saveSettings(resetChatLayoutPatch()); toast('Chat layout reset', 2000, 'ok'); rerender(); },
  }), { dataset: { setting: 'chatLayoutReset' } }), 'Also in the player: the chat button opens the same controls.'));
  for (const t of CHAT_TOGGLES) rows.push(row(t.label, toggle(t.key), t.help));

  // Quick chat: saved phrases, sent with one press from the player (the quick-chat icon, or the composer).
  const qc = quickChatSetting(s);
  rows.push(el('h3', { class: 'settings-subsection' }, 'Quick chat'));
  rows.push(row('Phrases for all channels', button(`Edit (${qc.global.length})`, () => phraseEditor('global', null, { onClose: rerender }), { dataset: { setting: 'quickChatGlobal' } }), 'Shown after the channel\'s own phrases. Emote names in a phrase are sent as emotes. Up to 30 phrases of up to 500 characters.'));
  const nChannels = Object.keys(qc.channels).length;
  rows.push(row('Phrases for one channel', button(nChannels ? `Choose (${nChannels} with phrases)` : 'Choose', () => pickChannelList({
    onClose: rerender,
    resolveLogin: async (login) => { const u = await tw.userByLogin(login); return u ? { id: u.id, login: u.login, name: u.display_name } : null; },
  }), { dataset: { setting: 'quickChatChannel' } }), 'The channel you watched last, one that has phrases, or any channel by name. In the player, Y in the quick-chat list edits a phrase and X adds one.'));

  // The real extensions exist only where the platform can load them (Electron).
  if (window.lurkbox && window.lurkbox.chatExtensionsStatus) {
    const status = el('div', { class: 'setting-help ext-status' });
    const show = (list) => status.replaceChildren(...list.map((x) => el('div', {}, extLine(x))));
    if (chatSettingOn(s, 'chatExtensions')) window.lurkbox.chatExtensionsStatus().then(show).catch(() => {});
    rows.push(row('Experimental: load browser extensions into Twitch chat mode', toggle('chatExtensions'),
      'Loads the real 7TV, BetterTTV and FrankerFaceZ extensions (downloaded from their GitHub releases) into Twitch chat style. Off by default. Applies to the next channel you open; an extension that fails is turned off and Lurkbox\'s own emotes keep working.'));
    if (chatSettingOn(s, 'chatExtensions')) {
      rows.push(row('Update extensions', button('Update', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Updating…';
        try {
          show(await window.lurkbox.chatExtensionsUpdate());
          toast('Extensions checked for updates', 3000, 'ok');
        } catch (err) {
          toast(`Update failed: ${err.message}`, 4000, 'warn');
        } finally {
          b.disabled = false;
          b.textContent = 'Update';
        }
      }, { dataset: { setting: 'chatExtensionsUpdate' } }), status));
    }
  }
  return rows;
}
