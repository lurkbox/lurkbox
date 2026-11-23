'use strict';
// Chat smoke test (needs network and a busy live channel): opens the channel with the Lurkbox chat panel on,
// waits for messages, then counts emotes per provider, overlays, badges and 7TV paints, and checks the bundled
// colour emoji font loaded. LURKBOX_TEST_CHANNEL picks the channel (default: the busiest live one);
// LURKBOX_SHOT=<file.png> saves a screenshot. Exits 0 when messages arrived with third-party emotes in them.
// LURKBOX_CHAT_STYLE=twitch checks Twitch chat style instead: Twitch's chat frame is zoomed for the TV (the zoom
// computed inside the frame matches Settings → Chat → Twitch chat size, LURKBOX_CHAT_SIZE, default Auto), keeps
// ~340 CSS px of layout width, shows messages, and the side panel doesn't overlap the video.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-chat-'));
// LURKBOX_CHAT_EXT=1: Twitch chat style with the experimental real extensions instead (downloads them).
const EXT = process.env.LURKBOX_CHAT_EXT === '1';
const TWITCH = EXT || process.env.LURKBOX_CHAT_STYLE === 'twitch';
const SIZE = process.env.LURKBOX_CHAT_SIZE ? Number(process.env.LURKBOX_CHAT_SIZE) : 'auto';
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ chatDefault: true, playerEngine: 'direct', chatStyle: TWITCH ? 'twitch' : 'lurkbox', chatExtensions: EXT, twitchChatSize: SIZE, videoOnlyUnfocused: false }));
process.env.LURKBOX_USER_DATA = userData;
const WAIT = Number(process.env.LURKBOX_CHAT_WAIT || 40000);

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(`[chat-smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  try { console.log(fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8').trim().split('\n').filter((l) => /\[chat\]|\[extensions\]/.test(l)).map((l) => `  log: ${l}`).join('\n')); } catch { /* no log */ }
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
};
setTimeout(() => finish(1, 'timed out'), WAIT + 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The busiest live channel, from Twitch's public web directory (anonymous), fetched synchronously before startup. */
function busiest() {
  const js = `fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }, body: JSON.stringify({ query: '{ streams(first: 1) { edges { node { broadcaster { login } } } } }' }) }).then((r) => r.json()).then((j) => process.stdout.write(j.data.streams.edges[0].node.broadcaster.login))`;
  return require('child_process').execFileSync(process.execPath, ['-e', js], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 }).trim();
}

const STATS = `(() => {
  const host = (s) => { try { const h = new URL(s).hostname; return h.includes('7tv') ? '7tv' : h.includes('betterttv') ? 'bttv' : h.includes('frankerfacez') ? 'ffz' : h.includes('jtvnw') ? 'twitch' : h; } catch { return '?'; } };
  const emotes = {};
  for (const i of document.querySelectorAll('#chat .emote')) emotes[host(i.src)] = (emotes[host(i.src)] || 0) + 1;
  return {
    messages: document.querySelectorAll('#chat .chat-msg:not(.system)').length,
    emotes,
    loaded: [...document.querySelectorAll('#chat .emote')].filter((i) => i.complete && i.naturalWidth > 0).length,
    stacks: document.querySelectorAll('#chat .emote-stack').length,
    badges: document.querySelectorAll('#chat .chat-badge').length,
    paints: document.querySelectorAll('#chat .chat-nick.paint').length,
    emojiFont: [...document.fonts].filter((f) => f.family.includes('Lurkbox Emoji')).map((f) => f.status),
    emojiCheck: document.fonts.check('32px "Lurkbox Emoji"', '\\u{1F600}'),
  };
})()`;

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (/error|uncaught/i.test(e.message)) console.log(`[renderer] ${e.message.slice(0, 300)} (${e.sourceId}:${e.lineNumber})`); });
  wc.once('did-finish-load', async () => {
    if (!/^http:\/\/localhost:/.test(wc.getURL())) return; // the hidden chrome://gpu window etc.
    await sleep(WAIT);
    // Put an emoji on screen in a title-sized line, so the screenshot shows the font.
    await wc.executeJavaScript("document.querySelector('#chat .chat-title').textContent += ' \\u{1F600}\\u{1F44D}\\u{1F3FD}\\u{1F1EF}\\u{1F1F5}'; document.fonts.load('32px \"Lurkbox Emoji\"', '\\u{1F600}')").catch(() => {});
    await sleep(1500);
    if (TWITCH && !EXT) return checkTwitchChat(win);
    if (EXT) {
      if (process.env.LURKBOX_SHOT) fs.writeFileSync(process.env.LURKBOX_SHOT, (await wc.capturePage()).toPNG());
      const log = fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8');
      const all = [...log.matchAll(/\[extensions\] active in chat frame: (\{.*\})/g)];
      const m = all[all.length - 1];
      if (!m) return finish(1, 'no extension probe result in the log');
      const found = JSON.parse(m[1]);
      return finish(Object.values(found).some(Boolean) ? 0 : 1, `extensions active in Twitch chat: ${m[1]}`);
    }
    const s = await wc.executeJavaScript(STATS);
    console.log(`[chat-smoke] ${JSON.stringify(s)}`);
    if (process.env.LURKBOX_SHOT) fs.writeFileSync(process.env.LURKBOX_SHOT, (await wc.capturePage()).toPNG());
    const thirdParty = (s.emotes['7tv'] || 0) + (s.emotes.bttv || 0) + (s.emotes.ffz || 0);
    if (!s.messages) return finish(1, 'no chat messages');
    if (!thirdParty) return finish(1, `no third-party emotes in ${s.messages} messages`);
    finish(0, `${s.messages} messages, ${thirdParty} third-party emotes, ${s.stacks} overlays, ${s.badges} badges, ${s.paints} paints`);
  });
});

/** Twitch chat style: zoom inside the frame, its layout width, its messages, and the panel beside the video. */
async function checkTwitchChat(win) {
  const wc = win.webContents;
  const { twitchChatZoom, twitchChatPanelWidth } = require('@lurkbox/core/src/shared/tv-zoom.js');
  const want = twitchChatZoom({ twitchChatSize: SIZE }, require('electron').screen.getPrimaryDisplay().size.height);
  // The visible panel frame (the hidden points frame next to it carries lurkbox=points and is never zoomed).
  const frame = wc.mainFrame.framesInSubtree.find((f) => /^https:\/\/www\.twitch\.tv\/embed\/[^/]+\/chat/.test(f.url) && !f.url.includes('lurkbox=points'));
  if (!frame) return finish(1, 'no Twitch chat frame');
  const inFrame = await frame.executeJavaScript(`({
    zoom: getComputedStyle(document.documentElement).zoom,
    layoutWidth: Math.round(innerWidth / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)), // CSS px Twitch lays out in
    messages: document.querySelectorAll('.chat-line__message, [data-a-target="chat-line-message"]').length,
  })`);
  const page = await wc.executeJavaScript(`(() => {
    const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; };
    return { panel: r('#twitch-chat-panel'), frame: r('#twitch-chat-panel iframe'), video: r('#player-screen video') || r('#player-screen iframe:not(.twitch-chat-host iframe)'), winWidth: innerWidth, mode: document.getElementById('twitch-chat-panel').className, points: document.getElementById('twitch-chat-host').className };
  })()`);
  console.log(`[chat-smoke] twitch chat: want zoom ${want}; frame ${JSON.stringify(inFrame)}; page ${JSON.stringify(page)}`);
  if (process.env.LURKBOX_SHOT) fs.writeFileSync(process.env.LURKBOX_SHOT, (await wc.capturePage()).toPNG());
  if (Math.abs(Number(inFrame.zoom) - want) > 0.01) return finish(1, `zoom inside the chat frame is ${inFrame.zoom}, expected ${want}`);
  if (page.points !== 'twitch-chat-host tc-hidden') return finish(1, `points frame not hidden (${page.points})`);
  if (page.mode !== 'twitch-chat-host tc-panel' || !page.frame) return finish(1, `chat panel not shown (${page.mode})`);
  const expectWidth = twitchChatPanelWidth(want, page.winWidth);
  if (Math.abs(page.frame.width - expectWidth) > 2) return finish(1, `chat frame is ${page.frame.width} px wide, expected ${expectWidth}`);
  if (page.video && page.video.right > page.panel.left + 1) return finish(1, `video (right ${page.video.right}) runs under the chat panel (left ${page.panel.left})`);
  if (!inFrame.messages) return finish(1, 'no messages in Twitch chat');
  finish(0, `Twitch chat zoom ${inFrame.zoom} (layout ${inFrame.layoutWidth} CSS px in a ${page.frame.width}-px frame), ${inFrame.messages} messages, video ends at ${page.video ? page.video.right : '?'} px, panel starts at ${page.panel.left} px`);
}

const channel = process.env.LURKBOX_TEST_CHANNEL || busiest();
console.log(`[chat-smoke] channel ${channel}`);
process.argv.push('--windowed', `--channel=${channel}`);
require('../../src/main/main.js');
