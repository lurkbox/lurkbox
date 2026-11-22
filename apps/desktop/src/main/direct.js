'use strict';
// Direct playback requests (web GQL + usher): shared with the other hosts, see packages/core/src/shared/direct.js.
const { matchGqlArchive, fetchLiveInfo, buildGqlRequest, usherUrl, fetchMaster, anonReasonFor, fetchStoryboard, WEB_CLIENT_ID, GQL_URL } = require('@lurkbox/core/src/shared/direct.js');

module.exports = { matchGqlArchive, fetchLiveInfo, buildGqlRequest, usherUrl, fetchMaster, anonReasonFor, fetchStoryboard, WEB_CLIENT_ID, GQL_URL };
