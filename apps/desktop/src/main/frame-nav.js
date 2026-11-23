'use strict';
// Controller navigation for twitch.tv pages: shared with the other hosts, see packages/core/src/shared/frame-nav.js.
const { navSource, ensureNavSource, pressSource, backSource, installNav, navTooBig, navInnermost, navIntersect, navNearestDelta } = require('@lurkbox/core/src/shared/frame-nav.js');

module.exports = { navSource, ensureNavSource, pressSource, backSource, installNav, navTooBig, navInnermost, navIntersect, navNearestDelta };
