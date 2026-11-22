'use strict';
// Clip playback sources: shared with the other hosts, see packages/core/src/shared/clips.js.
const { buildClipRequest, parseClipAccess, fetchClipSources, validSlug, CLIP_HASH } = require('@lurkbox/core/src/shared/clips.js');

module.exports = { buildClipRequest, parseClipAccess, fetchClipSources, validSlug, CLIP_HASH };
