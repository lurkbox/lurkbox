'use strict';
// Twitch auth and Helix: shared with the other hosts, see packages/core/src/shared/twitch-auth.js.
const { Twitch, HttpError, SCOPES, migrateTokens } = require('@lurkbox/core/src/shared/twitch-auth.js');

module.exports = { Twitch, HttpError, SCOPES, migrateTokens };
