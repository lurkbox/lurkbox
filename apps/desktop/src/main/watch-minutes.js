'use strict';
// Watch-time points ("minute-watched"): shared with the other hosts, see packages/core/src/shared/watch-minutes.js.
const { reportGate, minuteWatchedBody, findSettingsUrl, findSpadeUrl, lowestVariant, newestSegment, WatchMinutes, HIDDEN_LIMIT_MS } = require('@lurkbox/core/src/shared/watch-minutes.js');

module.exports = { reportGate, minuteWatchedBody, findSettingsUrl, findSpadeUrl, lowestVariant, newestSegment, WatchMinutes, HIDDEN_LIMIT_MS };
