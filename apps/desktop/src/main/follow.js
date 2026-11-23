'use strict';
// Follow and unfollow through Twitch's own channel page: shared with the other hosts, see
// packages/core/src/shared/follow.js (main.js gives runFollow a hidden BrowserWindow as its page).
const { SELECTORS, FOLLOW_TEXT, UNFOLLOW_TEXT, CONFIRM_TEXT, validLogin, channelUrl, pageSource, runFollow } = require('@lurkbox/core/src/shared/follow.js');

module.exports = { SELECTORS, FOLLOW_TEXT, UNFOLLOW_TEXT, CONFIRM_TEXT, validLogin, channelUrl, pageSource, runFollow };
