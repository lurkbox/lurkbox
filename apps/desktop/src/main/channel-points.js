'use strict';
// Channel points (scan, claim, balance, the rewards view's sources): shared with the other hosts, see
// packages/core/src/shared/channel-points.js.
const { SELECTORS, NAV_OPTIONS, parseBalance, scanSource, openRewardsSource, fitRewardsSource, closeRewardsSource, highlightTitle, isChatFrameUrl, isPointsFrameUrl, chatFrameModeFor, PointsTracker, noPointsDetail, NO_POINTS_AFTER } = require('@lurkbox/core/src/shared/channel-points.js');

module.exports = { SELECTORS, NAV_OPTIONS, parseBalance, scanSource, openRewardsSource, fitRewardsSource, closeRewardsSource, highlightTitle, isChatFrameUrl, isPointsFrameUrl, chatFrameModeFor, PointsTracker, noPointsDetail, NO_POINTS_AFTER };
