# Lurkbox

> **AI disclosure:** Lurkbox is vibe-coded. Claude (Anthropic's AI coding assistant) wrote nearly all of the code, artwork and docs, and it was tested by hand. Human review of the code has been limited, so expect rough edges and read it before trusting it with anything important. Bug reports welcome.

A couch and controller client for Twitch, made for SteamOS Game Mode. It runs as its own non-Steam shortcut, so [Floater](https://github.com/jancard/decky-floater) can float it over a game.

Lurkbox is not affiliated with or endorsed by Twitch.

## Screenshots

<p>
  <img src="docs/screenshots/following.png" width="49%" alt="Following: live channels you follow as cards with thumbnails, viewer counts and uptime, and offline channels with their avatars below">
  <img src="docs/screenshots/player.png" width="49%" alt="The player with its overlay open: channel name, LIVE badge, stream title, seek bar and a row of icon controls, with the Quality control focused">
</p>
<p>
  <img src="docs/screenshots/player-chat.png" width="49%" alt="The player with the chat panel beside the video: messages with badges, coloured names and emotes">
  <img src="docs/screenshots/player-rewind.png" width="49%" alt="Live rewind: scrubbing back along the seek bar with a preview frame above it, the stream marked Rewound">
</p>
<p>
  <img src="docs/screenshots/channel.png" width="49%" alt="A channel page: banner, avatar, name, follower count and Following heart, a LIVE card with a Watch button, the tabs Home, Videos, Clips, Schedule, Emotes and About, and the Home tab with the live stream and the next scheduled stream">
  <img src="docs/screenshots/channel-clips.png" width="49%" alt="A channel's Clips tab: period pills 24 hours, 7 days, 30 days and All time, the Y sort chip on Most viewed, and clip cards with length, views, title and who clipped them">
</p>
<p>
  <img src="docs/screenshots/channel-emotes.png" width="49%" alt="A channel's Emotes tab: pills 7TV 17, BTTV 0, FFZ 4 and Twitch 3, a search box, a grid of large emote pictures with their names, overlay emotes marked ZW, and the focused partyHat in a detail panel: provider 7TV, by BoxDoodles, zero-width yes, with Add to message and Add to quick chat">
</p>
<p>
  <img src="docs/screenshots/continue-watching.png" width="49%" alt="Following with the Continue watching row above Live: past broadcasts you started, each with a progress bar along the bottom of its picture, the minutes left, the channel, the title and when you last watched it">
  <img src="docs/screenshots/phone-continue-watching.png" width="24%" alt="Phone, portrait: Continue watching as a sideways scroller above the live cards, the next card peeking in from the right">
</p>
<p>
  <img src="docs/screenshots/subscriptions.png" width="49%" alt="Settings, Subscriptions: the channels you follow that you're subscribed to, each with its tier, who gifted it if it was a gift, and a Channel page button">
  <img src="docs/screenshots/blocked-users.png" width="49%" alt="Settings, Blocked users: four blocked users, each with an Unblock button, and a toast saying Blocked DuskWanderer">
</p>
<p>
  <img src="docs/screenshots/search-history.png" width="49%" alt="Search with an empty box: Recent searches, each with what was picked from its results (a channel or a category), the A search again and X delete hint, and Clear history">
  <img src="docs/screenshots/keyboard.png" width="49%" alt="The built-in on-screen keyboard over Search: equal keys in ten fixed columns, Space and Done spanning whole cells">
</p>
<p>
  <img src="docs/screenshots/quick-chat.png" width="49%" alt="Quick chat open above the player's lightning-bubble icon: the channel's own phrases with emotes first, then the phrases for all channels, with the A send, Y edit, X add hint">
  <img src="docs/screenshots/chat-emotes.png" width="49%" alt="The emote picker above the chat composer: a search box, tabs Recent, Twitch, 7TV, BTTV and FFZ, the message so far, and a grid of emotes">
</p>
<p>
  <img src="docs/screenshots/emote-search.png" width="49%" alt="Emote search: scopes All of 7TV and Seen channels, the query blob, Popular, Trending and Newest sorts with Animated only and Zero-width only filters, the note that it is browse only, a grid of emotes with their owners and the focused blobNodXL in a detail panel used in 719 channels">
  <img src="docs/screenshots/whispers.png" width="49%" alt="Whispers: a conversation with PixelMoth, their messages on the left and yours on the right with times, the message box at the bottom, the rail's Whispers item with an unread dot, and a toast: Whisper from NightOwlNoodles, Y Reply">
  <img src="docs/screenshots/multiview.png" width="49%" alt="Multi-view: four live streams in a 2x2 grid, each with a small LIVE badge and the channel name, the top right one outlined as the active tile with the sound">
</p>

![All seven themes on the Following screen: Lurkbox, Game Mode, Classic Purple, OLED, Daylight, High Contrast and a custom theme](docs/screenshots/themes.png)

More in [docs/screenshots/](docs/screenshots/): the Undo toast after removing from Continue watching, whispers, a clip in the player, a clip just made, a channel's schedule, pop-overs, chat over the video, the chat composer, categories, search, the on-screen keyboard, settings, "Who's watching?" and the phone sign-in. They come from demo mode (`npm run screenshots`): every channel, picture, chat message and emote is made up for Lurkbox, and nothing is real Twitch content.

## Install

- **Flatpak (Linux, KDE Discover):** open **https://lurkbox.github.io/lurkbox/** and click Install, or run `flatpak install --user https://lurkbox.github.io/lurkbox/io.github.lurkbox.Lurkbox.flatpakref`. It updates through Discover or `flatpak update`. This is Lurkbox's own signed repository, not Flathub. See [docs/flatpak.md](docs/flatpak.md), including the Steam shortcut form Floater needs (`/usr/bin/flatpak` with `run io.github.lurkbox.Lurkbox`) and the sandbox limits.
- **AppImage (SteamOS Game Mode with Floater):** download `Lurkbox-<version>-x86_64.AppImage` from the [latest release](https://github.com/lurkbox/lurkbox/releases/latest), then see [Steam (Game Mode)](#steam-game-mode) below.
- **Android (Google TV, tablets, phones):** download `Lurkbox-<version>-android.apk` from the [latest release](https://github.com/lurkbox/lurkbox/releases/latest) and sideload it. Each release lists SHA-256 checksums in `SHA256SUMS.txt`.

## Features (v0.1)

- **Controller UI.** A left rail (Following, Browse, Categories, Search, Drops, Settings) with card grids. A selects, B goes back, and LB/RB switch sections.
- **One sign-in, on the TV.** "Sign in" opens the twitch.tv login page inside Lurkbox (scaled up for the TV; the D-pad moves between fields, and the Steam keyboard or a real keyboard types). In the same window, Lurkbox then opens Twitch's Authorize page for its own Client ID (device-code flow, public client, no secret), and you press Authorize once. That one sign-in covers both the Twitch API (follows, raids, chat) and the video player (your subs and Turbo). Lurkbox checks that both halves are the same account.
  - **Sign in with your phone instead** (a code and QR code for twitch.tv/activate) is still offered. It leaves the player signed out, so Lurkbox then offers the TV login for the player.
  - **Add account** runs the same flow, starting signed out of twitch.tv; each account keeps its own encrypted player session.
- **Browsing.** Followed Live is the home screen; Browse, Categories and Search are the other sections.
- **Channel pages.** X on a live card (or a long-press; on TV and tablet it asks: Channel page or "Watch with…" for multi-view), an offline follow, a search result or the player's channel icon opens the channel's page: its banner, avatar, name, follower count, the Follow heart and, when live, a LIVE card with Watch. LB/RB (or the tabs) switch between:
  - **Home:** the live stream (or the last broadcast), the next scheduled stream, recent highlights and the last 30 days' most viewed clips.
  - **Videos:** Past broadcasts, Highlights or Uploads (Helix `/videos` type), sorted with Y.
  - **Clips:** from the last 24 hours, 7 days, 30 days or all time, sorted by views (default), newest or oldest with Y.
  - **Schedule:** the upcoming streams from Helix `/schedule`, with category and time in your time zone, and a channel's break; "No schedule" when there is none.
  - **Emotes:** the channel's 7TV, BetterTTV, FrankerFaceZ and Twitch (subscriber, follower and Bits; Helix `GET /chat/emotes`) emotes, each with its count: large pictures with their names (animated ones play unless Settings → Chat → Animated emotes is off), overlay (zero-width) emotes marked ZW, and a search box that filters by name (A opens the Steam keyboard or the built-in one). The focused emote shows bigger, with its provider, who made it (7TV, BetterTTV, FrankerFaceZ) and whether it is zero-width. A (or Add to message) adds it to your message for this channel, which is waiting in the chat box when you watch the channel (signed in, Lurkbox chat style); Y (or Add to quick chat) adds it to the channel's quick-chat phrases. On a touchscreen a tap selects an emote and the buttons do the rest. "Search all" opens Emote search for this channel.
  - **About:** the description, partner or affiliate, since when, category, language and tags. Panels and social links aren't in Twitch's public API, so "Open on twitch.tv" shows Twitch's own page for them.
  - The filters and sorts are remembered.
- **Clips.** A clip plays in the player like a video: quality, the seek bar and its scrubbing, LB/RB (or the overlay's icons) for the previous and next clip of the list, and "next clip" autoplay when one ends (Settings → Player → Next clip, on by default). The overlay shows the clip's title, CLIP, who clipped it, its views and date; **Watch from here** opens its broadcast at the clip's moment (Helix `vod_offset`) when Twitch still has it. Clips play from Twitch's MP4s (see [Unofficial Twitch interfaces](#unofficial-twitch-interfaces)); with the Twitch player chosen, or if that fails, Twitch's own clip embed plays them (no quality or seeking there).
- **Making clips.** The scissors in the live player's overlay make a clip of the stream as you (the official Helix `POST /clips`, permission `clips:edit`, requested at sign-in; a token without it asks you to sign in again). A toast says "Clip created" with a QR code and short link to its edit page (clips are edited on twitch.tv), and the clip joins **My clips** at the top of that channel's Clips tab (per account, on the device, up to 50). Twitch's answers become plain messages: clips turned off or limited to followers or subscribers, the channel isn't live, too many clips (Lurkbox waits until Twitch's reset), or Twitch being unavailable.
- **Continue watching.** Past broadcasts and other videos you started but didn't finish sit in a row at the top of Following (per account, most recent first, up to 20), with a progress bar and the minutes left. A plays on from where you stopped, without the "Continue watching?" question the player asks when you open the video elsewhere. To remove one: X on the focused card (the row's header chip and the focused card both say "X remove"), the ✕ on a card with a mouse or a finger, or a long-press (a menu with Remove and the channel page). A toast offers Undo for a few seconds (Y, or its Undo button); after that the position is forgotten too. A video drops off when it's finished (95 % watched or under 2 minutes left), when Twitch no longer has it, or after 30 days without watching. The row is a sideways scroller (D-pad left/right, or a swipe on a phone). Settings → General turns it off ("Continue watching row"; positions are still saved for the resume question) and "Clear watch history" forgets every position of the account. Clips aren't in it: they're at most a minute long.
- **Search history.** Search finds channels and categories. Opening it with an empty box shows your recent searches (per account, newest first, up to 20): A searches again, X deletes the highlighted one, and "Clear history" removes them all. A search is remembered when you pick a channel or category from its results, together with what you picked. Settings → General turns it off ("Search history") or clears it ("Clear search history"). It stays on the device, in Lurkbox's settings.
- **Sorting.** Y re-sorts the list you're on, and a small chip shows the current order ("Y sort: Most viewers"; tap or click it too). The focus stays in the same place, and the choice is remembered.
  - Following → Live: Most viewers (default), Recently started, Live longest, A–Z, or By game (grouped under small game headers). Following → Offline: Recently live, A–Z, Followed date. Y sorts whichever of the two has focus. Both are also in Settings → General.
  - Browse and a category's streams: Viewers, Newest, A–Z. A channel's videos: Newest, Oldest, Most viewed, Longest. Search results: Relevance (Twitch's order), Live first (default), A–Z.
  - The player's previous/next channel follows the order on screen.
- **Player.** Lurkbox plays streams itself by default (the "Direct" engine: hls.js), with the official Twitch embed as an automatic fallback. The video is always full-bleed. A (or moving the mouse, or a tap) brings up a translucent overlay: the channel's avatar and name, a ● LIVE / "−0:23 behind" / "Rewound" badge and the title (it scrolls when long), the seek bar, and one row of icons: play/pause, volume, quality, chat, send a message, quick chat, jump to live, channel points (with your balance), clip (scissors), channel page, more (reload, switch player, fullscreen, stream info) and back. The focused icon shows a small label ("Quality · 1080p60"); hovering or long-pressing shows it too. Volume, quality, chat, channel points and more open small pop-overs above their icon, and B closes them. The overlay hides after about 4 s without input. Y toggles chat. X jumps to live. LB/RB step through followed live channels.
- **Live chat layout.** The chat icon's pop-over changes chat while you watch: on/off, Lurkbox or Twitch chat, text size, panel width (the video shrinks beside it), left or right, height (30–100 % of the player, at the top or bottom; the video keeps its size), background opacity, and "over the video" (Lurkbox chat floats see-through on top of the stream; a shorter chat at the bottom moves up while the controls are shown). Sliders move with the D-pad (hold to go faster), the mouse or a finger. The same settings are in Settings → Chat, with "Reset chat layout".
  - **Direct playback uses Twitch's unofficial web endpoints.** See [Unofficial Twitch interfaces](#unofficial-twitch-interfaces). Ads are detected and labelled but **never skipped or filtered**.
- **Chat with emotes.** The Lurkbox chat panel shows Twitch emotes and badges, plus 7TV, BetterTTV and FrankerFaceZ emotes (7TV wins name clashes, then BetterTTV, then FrankerFaceZ, then Twitch), including animated and zero-width overlay emotes, and 7TV name paints, badges and personal emotes. New 7TV channel emotes appear live. Tap, long-press or click an emote or badge to see its name. Settings → Chat turns each source, animation and 7TV cosmetics on or off. In the Twitch chat style, Settings → Chat → Twitch chat size scales Twitch's own chat (and its rewards, predictions and polls) for the TV; Auto fits the screen. See [Third-party services](#third-party-services).
- **Chat sending.** In the Lurkbox chat style, a compact composer sits at the bottom of the chat panel, and the overlay's "Send a message" icon (a keyboard) focuses it and opens a keyboard: Steam's on-screen keyboard in Game Mode, Lurkbox's own one elsewhere; a real keyboard types straight in. Enter (or A on Send) sends, B leaves (the draft stays). Messages go out as your signed-in account through the official Helix API (`POST /chat/messages`), show at once and are confirmed when chat echoes them back; a message Twitch refuses is crossed out with "not sent" and a toast gives Twitch's reason (duplicate, slow mode, followers-, subscriber- or emote-only, banned, …). Slow mode, followers-only, subscriber-only, emote-only and unique-chat show as a small note above the box, and Lurkbox waits out slow mode and rate limits itself. A counter appears near Twitch's 500-character limit. In the Twitch chat style, Twitch's own chat frame has its input, so the composer is hidden.
- **Whispers.** The Whispers section (on the rail; on a phone, in the account avatar's menu, whose avatar shows the unread dot) lists your conversations, newest first, with a dot on unread ones. A opens one: the messages, and the chat's message box at the bottom (Steam's keyboard, Lurkbox's own, or the system keyboard on touch); the D-pad up/down scrolls. "New whisper" asks for a Twitch user name. Whispers arrive over Twitch's official EventSub (`user.whisper.message`) while you're signed in and Lurkbox runs, and go out through Helix (`POST /whispers`). One that comes in while you're elsewhere shows a toast, "Whisper from …", where Y replies; with "Hide chat and controls when Lurkbox isn't focused" on there's no toast over the video while another app has focus. Twitch's rules show as messages: sending needs a verified phone number on your account, the other person may not accept whispers from you, at most 40 new people a day (3 a second, 100 a minute), and 500 characters for a first whisper (10,000 once they've whispered you). A whisper Twitch refuses stays in the conversation marked "not sent". History is kept on this device only, per account (up to 50 conversations of 200 messages); Settings → General → "Clear whispers" deletes it, and removing an account deletes its whispers.
- **On-screen keyboard.** Where Steam's keyboard isn't available, A on a text box opens Lurkbox's own: a grid of equal keys in ten fixed columns (Space, Shift, Done and the rest span whole cells), so up and down always stay in the same column and left and right wrap at the row ends; holding a direction repeats. `#+=` switches to symbols and numbers. X deletes, Y types a space, LB/RB shift, Menu finishes. Keys are big enough to tap or click.
- **Emote picker.** The composer's smiley button (or X in the box) opens a grid with tabs: Recent (per account), Twitch (your own emotes, from the official Helix `GET /chat/emotes/user`, including the channel's follower emotes), and the channel's 7TV, BetterTTV and FrankerFaceZ emotes. A search box at the top filters every tab by name as you type (with the on-screen keyboard, Steam's keyboard or a system keyboard; names starting with the text come first, and each tab shows its number of matches); DOWN goes from the box to the results. A inserts the emote's name at the cursor, LB/RB switch tabs, B closes. Your own messages show your Twitch emotes as soon as you send them.
- **Emote search.** From Search (the Emotes button) or a channel's Emotes tab (Search all), two scopes (LB/RB):
  - **All of 7TV:** 7TV's public search as you type (it waits for a pause), sorted Popular, Trending or Newest, with "Animated only" and "Zero-width only" filters; more results load as you scroll. Each emote shows its picture, name and owner; the detail panel adds how many channels use it. It's browse only: use an emote in chat only where a channel has it enabled. Y (or Add to message) adds the name to your message for the channel you came from (signed in).
  - **Seen channels:** one search across the emotes of every channel whose chat or Emotes tab Lurkbox has loaded for your account (up to 20,000 emotes, the least recently seen channels dropped first), exact names first, then names starting with the text, then names containing it. Each result shows its channel; A opens that channel's Emotes tab on the emote, Y adds it to your message for that channel. Settings → Chat → Clear emote index forgets them.
- **Quick chat.** Saved phrases sent with one press: the overlay's quick-chat icon (a chat bubble with a lightning bolt, in both chat styles) or the composer's button (or Y in the box). The channel's own phrases come first, then the ones for all channels; emote names in a phrase show and send as emotes. A sends at once; a phrase rests 3 s before it can go again, and slow mode is waited out. Y edits the highlighted phrase, X adds one. Settings → Chat → Quick chat edits the list for all channels and any channel's own list (add with the keyboard, edit, delete, reorder). It starts with "gg", "LUL", "hype!", "o7" and "PogChamp".
- **Colour emoji everywhere.** Lurkbox bundles Noto Color Emoji (SIL Open Font License 1.1, `packages/core/src/fonts/OFL-NotoColorEmoji.txt`), because SteamOS Game Mode may have no colour emoji font.
- **Drops.** The Drops section shows Twitch's own Drops Inventory page (twitch.tv/drops/inventory) with your TV sign-in, zoomed for the TV: the D-pad moves between the page's buttons and links, A presses, B leaves a dialog and then goes back to the rail, Y reloads. Without a twitch.tv session it offers the sign-in. **Auto-claim drops** (Settings → Player, on by default) checks that page in a hidden window a minute after Lurkbox starts and then every 15 minutes, presses its Claim button for finished drops and shows "Drop claimed: <name>". In the player, a small chip ("Drop 45% · <name>") shows your progress when the inventory lists a drop in progress for the stream's game. Twitch's public API can't tell whether a stream has drops enabled, so the chip only means "you are earning a drop for this game".
- **Follow and unfollow.** A Follow / Following button (heart) on the channel page, and a heart in the player's icon row ("Follow" / "Following · Unfollow?"). Unfollow always asks first. Lurkbox presses Twitch's own button on the channel's twitch.tv page for you and shows "Followed <name>" / "Unfollowed <name>" once the button has flipped; Following then reloads its list. Without a twitch.tv session it offers the sign-in. If Twitch asks for a captcha or the button doesn't flip, "Couldn't follow, open on twitch.tv" opens the channel's page in Lurkbox (zoomed for the TV, the D-pad moves, B closes) so you can press it yourself. Whether you follow a channel comes from the official API.
- **Subscriptions.** Settings → Account → Subscriptions lists the channels you follow that you're subscribed to, with the tier (Tier 1, 2 or 3), "gifted by <name>" for a gift sub, and a Channel page button. Followed channels you're subscribed to also get a "Sub" badge on their cards in Following. Twitch's API can only check one channel at a time (`GET /subscriptions/user`), so Lurkbox checks your follows a couple at a time, spaced out, and remembers the answers for an hour.
- **Blocking.** A on a chat line (Up from the message box picks lines, A opens the line) or a click or tap on a name opens a small card: View channel, and Block. The channel page has Block too. Blocking always asks first, then uses the official Helix `PUT /users/blocks`. Lurkbox chat hides messages from blocked users (Settings → Account → "Hide messages from blocked users", on by default). Settings → Account → Blocked users lists everyone you've blocked, with Unblock (also after a confirm).
- **Multi-view (TV and tablet).** Watch 2–4 live streams at once: "Add stream to multi-view" in the player's More, or X (or a long-press) on a live card → "Watch with…", then pick from the followed channels that are live (A ticks several at once, up to the free tiles; Start or Y opens them). Two play side by side, three as one big plus two small, four in a 2x2 grid; Y (or the tile menu's Layout) switches the layout. One tile is active (outlined): only it has sound, the chat side panel follows it, and it plays at your normal quality while the others are capped (Settings → Player → "Multi-view quality for other tiles": 480p by default, 720p or Same). The D-pad moves the active tile; A opens its menu (quality, chat, send a message, layout, add a stream, move to the big tile, remove, watch only this); X adds a stream; View/Select (or RIGHT past the last tile) goes to the chat's message box, with emotes and quick chat as in the player; B goes back to the single player on the active stream. A raid on any tile counts down on that tile (a small banner; on the active tile B stays and A goes now, and the tile menu has both) and then plays the raid target in that tile. The last set is remembered per account: "Resume multi-view" in the player's More and in a live card's X menu opens it again when two or more of its channels are live. Each tile is its own player: if one can't play (often the device's limit on hardware decoders), it shows why and the others keep going. The background quality cap applies to every tile. On a phone it says "Multi-view needs a bigger screen".
- **Raid following.** When the channel you are watching raids, a "Raiding <name>" countdown appears. B cancels it, A goes right away.
- **Themes.** Lurkbox, Game Mode, Classic Purple, OLED, Daylight, High Contrast and Custom (your own colours, edited with the controller), with a live preview in Settings.
- **Steam library art that matches your theme (optional).** Settings → Appearance → "Match Steam library artwork to theme" recolours Lurkbox's capsule, wide capsule, hero, logo and shortcut icon in the Steam library whenever you pick a theme. It is off by default. See [Steam library art](#steam-library-art).
- **Floater-friendly.** Lurkbox never pauses on blur or when hidden, has no background throttling, plays its own audio stream, and never uses exclusive fullscreen.

## Repository layout

Lurkbox is one codebase for several platforms, organised as npm workspaces:

| Path | What it is |
|---|---|
| `packages/core/` | `@lurkbox/core`: the platform-neutral app. The TV UI (`src/index.html`, `css/`, `js/`, `js/views/`, `fonts/`), the Twitch, chat and theme logic, and the shared settings schema and Twitch config (`src/shared/`). Plain browser code: no Node, no Electron. Its only contact with the host is `window.lurkbox`, documented in `src/platform.d.ts`. Tests in `test/`. |
| `apps/desktop/` | The Electron app for SteamOS and Linux: main process (`src/main/`), `preload.js` (the desktop `window.lurkbox`), `login-preload.js`, the electron-builder config, the Flatpak manifest, metadata and Pages site (`flatpak/`), the deploy and Steam shortcut scripts (`scripts/`), and its unit and smoke tests (`test/`). |
| `apps/android/` | Early: the Capacitor app for Android TV / Google TV, tablets and phones, its `window.lurkbox` (`src/`) and the Android project (`android/`). See [docs/android.md](docs/android.md). |
| `assets/` | Icons, Steam library art and their sources, shared by the apps. |
| `docs/` | [Architecture](docs/architecture.md), [development](docs/development.md), the [Flatpak](docs/flatpak.md) and the [Android plan](docs/android.md). |
| (separate repo) | The Decky companion plugin: [lurkbox/decky-lurkbox](https://github.com/lurkbox/decky-lurkbox). |

## Android (early)

One Android app for Android TV / Google TV, tablets and phones is in `apps/android` (Capacitor, the same core). It's early and not yet tested on real devices: phone (device-code) sign-in, Helix, and live, VOD and clip playback with the direct engine. On a TV the remote's D-pad or a game controller drives the TV layout; on a touchscreen without a controller the layout follows the screen (Settings → Layout: Auto, TV, Tablet, Phone):

- **Phone:** a bottom tab bar and a top app bar with your avatar; in portrait the video sits on top with the chat below it, held sideways the video fills the screen and the chat swipes in from the right. Pop-overs are bottom sheets.
- **Tablet:** the rail (icons only when narrow), the chat beside the video in landscape and below it in portrait.
- **Touch:** tap to select, long-press a live card for its channel page (or a recent search to delete it), swipe between a channel's tabs, pull a list down to refresh, double tap the left or right half of a video or clip to seek 10 s, drag the seek bar, swipe down to close the player. Typing uses the phone's own keyboard. Android's Back button or gesture is B everywhere.

<p>
  <img src="docs/screenshots/phone-player.png" width="24%" alt="Phone, portrait: the live video on top with its controls, the chat filling the screen below it, and the message box at the bottom">
  <img src="docs/screenshots/phone-following.png" width="24%" alt="Phone, portrait: Following as one column of live cards, a top bar with the section name and the account avatar, and a bottom tab bar: Following, Browse, Categories, Search, Drops, Settings">
  <img src="docs/screenshots/phone-channel.png" width="24%" alt="Phone, portrait: a channel page with banner, avatar, follower count, the LIVE card with Watch, and tabs that scroll sideways">
  <img src="docs/screenshots/phone-clip.png" width="24%" alt="Phone, portrait: a clip playing after a double tap on the right half, showing +10 s, with the seek bar and controls at the bottom">
</p>
<p>
  <img src="docs/screenshots/phone-landscape.png" width="49%" alt="Phone held sideways: the video full screen with the chat panel swiped in from the right">
  <img src="docs/screenshots/tablet-player.png" width="49%" alt="Tablet, landscape: the player with touch-sized controls and the chat as a side panel">
</p>
 The TV sign-in (twitch.tv login, then Authorize, in an in-app window) and subs/Turbo in the player work; channel points, Drops, follow and the Steam features aren't there yet. `npm run android:build` makes a debug APK (JDK 21 and the Android SDK needed); install it with `adb install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk`. Details in [docs/android.md](docs/android.md).

## Setup (development)

Run everything from the repository root. See [docs/development.md](docs/development.md) for details.

```sh
npm install
npm rebuild electron          # needed when npm runs with ignore-scripts=true
npm start -- --windowed       # desktop window instead of fullscreen
npm start -- --windowed --channel=somechannel   # open a channel directly
```

- **Client ID.** The built-in public Client ID is in `packages/core/src/shared/config.js`, and a Client ID saved in Settings overrides it. The Twitch app must be a **Public** client so the device flow works without a secret.
- **Scopes.** All scopes Lurkbox may need are requested once, at sign-in (`SCOPES` in `packages/core/src/shared/config.js`). If a stored token lacks any of them, Lurkbox asks you to sign in again.
- **Where data lives.** Tokens and settings are in `~/.config/Lurkbox/` (`tokens.json` is mode 0600). Nothing is stored in the repo.
- **VS Code terminals.** These set `ELECTRON_RUN_AS_NODE=1`, which makes Electron act as plain Node. The `start` script unsets it.

## Build

```sh
npm run dist        # dist/Lurkbox-0.1.0-x86_64.AppImage (electron-builder, config in apps/desktop/electron-builder.config.js)
```

The Flatpak manifest is `apps/desktop/flatpak/io.github.lurkbox.Lurkbox.yml`. It packages the electron-builder `--dir` output on top of `org.electronjs.Electron2.BaseApp`. CI builds it and publishes it to https://lurkbox.github.io/lurkbox/ ([docs/flatpak.md](docs/flatpak.md)).

## Tests

```sh
npm test            # node --test unit tests of every workspace (packages/core/test, apps/desktop/test/unit), no network needed
npm run test:smoke  # launches Electron windowed and waits for the welcome screen (CI runs it under xvfb-run)
npm run test:play   # embed engine plays a live channel (needs network; LURKBOX_TEST_CHANNEL)
npm run test:direct # direct engine plays a live channel
npm run test:vod    # direct engine plays a VOD
npm run test:rewind # live rewind on the direct engine
npm run test:points # channel-points scanning against a local fixture
npm run test:drops  # drops: inventory scanning, claiming and controller navigation against a local fixture, and the Drops section's focus (stable while idle, the D-pad moves)
npm run test:follow # follow/unfollow against a local fixture of a channel page: selectors, the flip check, retry, captcha, wrong channel
npm run test:chat   # Lurkbox chat on a busy live channel: emotes, overlays, badges, paints (LURKBOX_SHOT=x.png saves a screenshot)
npm run test:channel     # offline, in demo mode: X on a live card opens its channel page; every tab, the video and clip filters and sorts, a clip made from the live player (toast with QR code, My clips), a clip played (qualities, next-clip autoplay, "Watch from here"), LB/RB, back
npm run test:multiview   # offline, in demo mode: X on a live card → Watch with… (multi-select), 2 then 4 tiles playing, the sound and the quality cap follow the active tile, the layouts, raids on two tiles (one followed in place, one cancelled), sending from the active tile's chat, B back to the single player, Resume multi-view
npm run test:continue    # offline, in demo mode: the Continue watching row (above Live, the deleted VOD dropped), D-pad scroll, A plays from the saved position without the question, the row refreshes after the player, X → Remove → Y undo, ✕ → forgotten after the toast, Clear watch history
npm run test:chat-send   # offline, in demo mode: sends a message with the controller and the on-screen keyboard, sees it echoed, a refused duplicate marked, an emote inserted from the picker, and quick-chat phrases sent and echoed
LURKBOX_CHAT_STYLE=twitch npm run test:chat   # Twitch chat style: the frame's TV zoom, panel width, no overlap with the video (LURKBOX_CHAT_SIZE=175 for a fixed size)
LURKBOX_CHAT_EXT=1 npm run test:chat   # the experimental real extensions in Twitch chat style
npm run screenshots # the README screenshots, in demo mode (see docs/development.md)
```

The unit tests cover:
- the platform interface: every `window.lurkbox` member the core uses is documented in `packages/core/src/platform.d.ts`, and the desktop preload exposes exactly those;
- the device flow and token refresh;
- the TV sign-in (login → Authorize → matching accounts, mismatch, cancel, add account, re-auth, phone fallback);
- EventSub raid subscriptions and the countdown;
- IRC parsing and the 150-message chat cap;
- chat sending: the Helix request, `is_sent: false` with `drop_reason`, 429s, sign-in and scope checks, room modes from ROOMSTATE and the composer's note, the 500-character limit and counter, matching the IRC echo to the message drawn at once, slow-mode and rate-limit waits;
- Emote search: the 7TV request and response mapping (mocked fetch), the debounce, paging and dropped stale answers; the seen-channels index (add, the 20,000 cap, least recently seen channels first, per account, validation) and its ranking (exact > prefix > contains); demo mode's made-up catalogue (no network);
- the emote picker and quick chat: inserting an emote at the cursor (never over 500 characters), the picker's tabs and its search filter (every tab, prefix matches first, the "no matches" note), your own emotes over every Helix page, recent emotes per account, quick-chat storage sanitising (≤ 500 characters, ≤ 30 per list, channels by broadcaster id), the channel's phrases before the global ones, list edits and reordering, the per-phrase cooldown;
- chat emotes: placement from the IRC tag (emoji and surrogate pairs before an emote), 7TV > BTTV > FFZ > Twitch precedence, zero-width layering, BTTV/FFZ modifiers, 7TV paints and EventAPI events, badge lookup, the chat settings;
- the experimental extension manager: version parsing, release picking, archive extraction (zip-slip refused), load failures;
- settings validation and the local server;
- spatial focus and gamepad mapping, repeat and dedupe;
- the player overlay: which icons show, their label text ("Quality · 1080p60"), the live badge, pop-over placement and focus return (B goes back to the icon), slider steps and hold-to-accelerate;
- the chat layout: width (Auto, percentages, at most half the window, Twitch chat's minimum layout width), height and position (the 30–100 % clamp, top/bottom anchoring, lifting above the control bar over the video, the layouts that ignore it), text size and Twitch chat zoom, "over the video" rules, and one settings source for the pop-over and Settings → Chat (live preview, delayed save, echoes never move a slider back);
- Drops: the auto-claim loop (first check after 1 min, then every 15, never twice in 5 min, error backoff, inert with the setting off or without a twitch.tv session, names only in logs), the framing headers, the Claim button text, the player's chip for a stream's game, and which keys go to the inventory page;
- follow/unfollow: unfollow only after Lurkbox's confirmation (also when "Following" is stale), the flip check, one retry on timeout and none after a captcha, inert without a twitch.tv session, only valid channel logins, the sign-in prompt and the "open on twitch.tv" fallback, the heart's label and icon;
- making clips: the clips:edit check (re-sign-in), the Helix request, its answers (202 with the edit link, 401, 403 off or restricted, 404 not live, 429 with the reset, 5xx), only Twitch edit links, "My clips" per account (validated, newest first, at most 50), and the demo's echo (including its not-live, clips-off and rate-limit answers);
- clip playback: the GQL request (persisted query, then the plain one), signing each MP4 quality, host checks, a deleted clip, network errors; which quality plays (the default quality setting, a chosen one, the background cap); the MP4-or-embed choice; the overlay's clip controls and labels; the demo's clip MP4s with byte ranges;
- the channel page: the Helix wrappers for videos (by type), clips (the period's window), clip by id, the schedule (404 = no schedule), followers and channel info, and their pagination over every page; schedule segments (upcoming, cancelled, vacation) and their times across time zones (Today/Tomorrow by the zone's calendar); clip sorting; the saved filters;
- Continue watching: the row's rules (started, finished at 95 % or under 2 minutes left, 30 days, 20 items, newest first), the card's progress and "x min left", the stored video details (validated), the per-account store (list, clear, details kept between saves), the lazy removal of VODs Helix no longer has, and the sideways row's scroll maths;
- multi-view: the layout geometry (side by side, one big plus two, 2x2), D-pad moves between tiles, only the active tile unmuted, the quality cap rule (the setting for other tiles, the background cap for all, the lower wins), adding (no duplicates, at most four), removing (the active tile follows; one left goes to the single player), swapping, a raid replacing its tile, and B to the active stream; every tile's raid subscription on one EventSub socket (added and deleted as tiles change, capped at the connection's cost limit) and per-tile raid countdowns; the multi-select picker's limits; the saved set per account and when it can be resumed;
- theme tokens and chat colour contrast;
- Steam library art: appid derivation, the allow-listed Steam expressions, grid file names, and backup before the first overwrite.
- demo mode: the made-up data behind the Helix and `window.lurkbox` seams, the fake chat (including the echo of messages you send), emote APIs and playlists, that it only turns on for `LURKBOX_DEMO=1`, and that it makes no network calls (fetch and WebSocket throw in those tests).

## Steam (Game Mode)

1. Copy the AppImage to `~/Applications/Lurkbox.AppImage` and make it executable.
2. In Desktop Mode, choose Steam → Add a Non-Steam Game, select the AppImage, and name the shortcut **Lurkbox**.
3. Launch options (optional):
   - `--ozone-platform=x11` makes Electron render through XWayland. Put it here, on the real command line: Lurkbox adds it under Gamescope only when `WAYLAND_DISPLAY` is unset, because adding it from the main script reaches only the GPU process. If that doesn't match the browser's platform, the GPU process crashes and video falls back to software decoding.
   - `--appimage-extract-and-run` helps if FUSE is unavailable.
   - `--channel=<login>` opens a channel at start.
4. Controller: the default **Gamepad** Steam Input template works; the Deck shows up as an Xbox-style pad. A **Keyboard and Mouse** template also works, because Lurkbox reacts to keys and the mouse too.
5. Steam + X opens the Steam keyboard while a text box is focused. Pressing A on a text box opens Lurkbox's own on-screen keyboard.

### Steam library art

Settings → Appearance → **Match Steam library artwork to theme** (off by default) redraws the library art in the current theme's colours when you commit a theme (A in the theme picker, or Save in the custom colour editor), never during the live preview.

- **Files.** It writes `<appid>p.png`, `<appid>.png`, `<appid>_hero.png`, `<appid>_logo.png` and `<appid>_icon.png` to `~/.local/share/Steam/userdata/<id>/config/grid/`, where `<id>` is the Steam user whose `shortcuts.vdf` contains Lurkbox. The first time, it backs up the originals to `~/.config/Lurkbox/steam-art-backup/<appid>/`.
- **Appid.** It is taken from `SteamGameId` (set by Steam at launch), otherwise from the AppImage path, the same way Steam computes it for non-Steam shortcuts.
- **Live update. This uses Steam's internal, undocumented client interface, which Decky Loader enables, and it may break with any Steam update.** When Steam's CEF remote debugging is on (`127.0.0.1:8080`), Lurkbox connects to Steam's `SharedJSContext` and calls only `SteamClient.Apps.SetCustomArtworkForApp`, `ClearCustomArtworkForApp` and `SetShortcutIcon`, built from a validated numeric appid and PNG data. Without it, the art (but not the shortcut icon) changes the next time Steam restarts.
- **Restore original Lurkbox art** (same section) puts the backed-up or shipped art back, resets the shortcut icon and turns the setting off.
- Failures never stop Lurkbox: they show a message and are written to `lurkbox.log` with a `[steam-art]` prefix.

### Controls

| Action | Controller | Keyboard | Mouse |
|---|---|---|---|
| Move | D-pad / left stick | Arrows / WASD | hover |
| Select | A | Enter / Space | click |
| Back | B | Esc / Backspace | right-click |
| Player overlay | A, or any D-pad direction (in player) | Enter | move the mouse, or click the video |
| Close a pop-over (focus goes back to its icon) | B | Esc | click outside it |
| Slider (pop-overs, Settings → Chat) | D-pad left/right, hold to go faster | Arrows | drag |
| Delete a recent search (Search, empty box) | X | | |
| Reply to a whisper (while its toast shows) | Y | | Reply on the toast |
| Channel page or multi-view ("Watch with…") of a live card | X | | long-press (touch) |
| Multi-view: active tile, its menu, add a stream, layout, leave | D-pad, A, X, Y, B | | click a tile (again for its menu) |
| Multi-view: message box of the active tile's chat | View/Select | | |
| Channel page tabs | LB / RB | Q / E | the tabs |
| Sort the list (Following, Browse, a category, a channel's videos, Search) | Y | C | the sort chip |
| Chat | Y | C | chat icon |
| Send a message | View/Select (straight in, with the keyboard), or D-pad toward the chat then A, or Send a message in the overlay; Send sends | type, Enter sends | click the box |
| Leave the chat box | B | Esc | |
| Emote picker, quick chat (in the chat box) | X, Y | | smiley, lightning buttons |
| In quick chat: send, edit, add | A, Y, X | Enter | click |
| Jump to live | X | L | Jump to live (overlay) |
| Previous / next channel (in player; a clip: previous / next clip); sections (elsewhere) | LB / RB | Q / E, PageUp / PageDown | |
| Fullscreen | | F11 | |

Button hints change with the last input used: Xbox-style letters, PlayStation symbols, Nintendo labels, or key names. Raw controllers (with Steam Input off) use fallback tables for Xbox, DualShock/DualSense, Switch Pro, 8BitDo and Valve pads, plus a generic mapping.

## Floater notes

- Floater captures Lurkbox's own Gamescope stream by appid, so Lurkbox must be its own non-Steam shortcut.
- **When Lurkbox loses focus** (e.g. while you play a game under Floater), the player hides chat and controls after 1.5 s so only the video shows. A raid notice still appears.
- **Playback keeps going without focus.** Lurkbox sets `backgroundThrottling: false` plus the `disable-renderer-backgrounding`, `disable-background-timer-throttling` and `disable-backgrounding-occluded-windows` switches. A script injected into the player frame keeps its page visibility at "visible".
- **The controller is ignored while another app has focus,** so pressing buttons in your game doesn't also drive Lurkbox. Settings → "Controller input when unfocused" turns that off.
- The **High Contrast** theme (thick yellow focus ring, no transparency) stays easiest to read at small sizes, and **OLED** keeps the screen mostly black.

## Unofficial Twitch interfaces

Most of Lurkbox uses Twitch's official, documented API (Helix, EventSub, the device-code sign-in), through Lurkbox's own Client ID. A few features need things the official API doesn't offer to viewers. For those, Lurkbox uses the same undocumented web endpoints that twitch.tv itself, and tools such as Streamlink, use. They aren't covered by Twitch's developer terms, so Twitch could change or block them at any time, and using them is at your own risk. Each one can be turned off:

| Feature | What it uses | How to turn it off |
|---|---|---|
| **Direct playback** (default player), VOD seek previews, live rewind | Twitch web GQL `PlaybackAccessToken` (Twitch's web client ID, plus your twitch.tv session so subs and Turbo apply) and the usher HLS playlists; GQL `seekPreviewsURL` for the scrubbing thumbnails; when signed out, GQL for the live stream's start time and archive VOD (signed in, Helix) | Settings → Player → Player: **Twitch player** (the official embed) |
| **Clip playback** | Twitch web GQL `VideoAccessToken_Clip` (Twitch's web client ID, anonymous): the clip's MP4 qualities and a signed playback token, the same way twitch.tv and Streamlink play clips | Settings → Player → Player: **Twitch player** (clips then use the official clip embed, `clips.twitch.tv/embed`) |
| **Channel points** (claim the bonus, balance, rewards, predictions, polls) | Twitch's own embedded chat page, signed in with your twitch.tv session; Lurkbox clicks the bonus button for you | Settings → Player → Auto-claim bonus points; Chat style |
| **Drops** (the Drops section, auto-claim, the player's progress chip) | Twitch's own Drops Inventory page (`www.twitch.tv/drops/inventory`) with your twitch.tv session: shown in the Drops section (Lurkbox removes that page's `X-Frame-Options` and CSP `frame-ancestors` headers so it can be framed in Lurkbox's own window), and loaded in a hidden window every 15 minutes, where Lurkbox reads the campaigns in progress and clicks the page's own Claim buttons for finished drops (at most 5 per check; errors back off up to 4 h). No GQL calls | Settings → Player → **Auto-claim drops** (the Drops section only loads the page while you open it) |
| **Follow / unfollow** | Twitch's own channel page (`www.twitch.tv/<channel>`) with your twitch.tv session, loaded in a hidden window only when you press Follow, or confirm Unfollow, in Lurkbox. Lurkbox presses the page's own Follow button (or Unfollow and Twitch's confirm dialog) in the channel header for that channel only, and reports success only when the button has flipped (one retry; no retry after a captcha). Twitch removed the public follow API in 2023. Whether you follow comes from the official Helix `GET /channels/followed`. No GQL calls | Don't press Follow: nothing runs in the background |
| **Earning watch-time points with Direct playback** | The same "minute watched" reports Twitch's own player sends (a HEAD of the newest segment of your signed-in playlist and a `minute-watched` event to Twitch's analytics endpoint), once a minute, only for the stream on screen while it plays live (not paused, not rewound, not hidden for over 5 min) | Settings → Player → Earn channel points while watching |
| **Notification-bell sync for the Decky plugin** | Twitch web GQL, reading which followed channels have the bell turned on | Leave the plugin on "All followed" or "Only my list" |
| **Steam library art that follows the theme** | Steam's internal client API, through the debugging port Decky Loader enables (not a Twitch API) | Settings → Appearance (off by default) |

## Third-party services

Lurkbox chat loads emotes and cosmetics from these public, third-party APIs (not Twitch). Each can be turned off in Settings → Chat:

| Service | What Lurkbox asks for |
|---|---|
| **7TV** (`7tv.io`, `events.7tv.io`, images from `cdn.7tv.app`) | the global and channel emote sets; Emote search's "All of 7TV" (the public v4 GraphQL API at `7tv.io/v4/gql`: `emotes.search`, and an emote's channel count; read only, no account); a read-only EventAPI connection for the channel you watch (emote changes, chatters' name paints, badges and personal emotes) |
| **BetterTTV** (`api.betterttv.net`, `cdn.betterttv.net`) | the global and channel emotes |
| **FrankerFaceZ** (`api.frankerfacez.com`, `cdn.frankerfacez.com`) | the global and channel (room) emotes |

Lurkbox only reads; it sends nothing about you to these services. Twitch badges come from the official Helix API.

**Experimental: real browser extensions.** Settings → Chat → "Experimental: load browser extensions into Twitch chat mode" (off by default) downloads the official 7TV, FrankerFaceZ and BetterTTV packages from their GitHub releases into `~/.config/Lurkbox/extensions/` and loads them into Twitch's embedded chat (the "Twitch chat" chat style). Lurkbox restricts them to Twitch's embedded and popout chat pages, and keeps them out of the hidden chat frame that Lurkbox chat style uses for channel points (they replace Twitch's chat UI, so Twitch's points summary would never render). BetterTTV publishes only its page script on GitHub, so Lurkbox wraps it in a small generated manifest. All three were verified working in Electron 45. An extension that fails to load is turned off and the reason is logged (`[extensions]` in `lurkbox.log`); Lurkbox's own chat emotes don't depend on them.

What Lurkbox never does: skip, block or filter ads, use Twitch's private API (GQL) to follow, unfollow, subscribe or change your account in any other way, or send anything for streams you aren't watching. Follow and unfollow press Twitch's own button on its page, and only when you ask.

## License

Lurkbox is free software under the [GNU General Public License v3.0 or later](LICENSE). The bundled Noto Color Emoji font and the Bricolage Grotesque wordmark outlines are under the SIL Open Font License (see their licence files). Lurkbox is not affiliated with or endorsed by Twitch.
