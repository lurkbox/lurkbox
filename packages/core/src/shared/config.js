// Built-in defaults, shared by every platform (ES module; the desktop main process loads it with require()).
// The Client ID belongs to a public Twitch app (device-code
// flow, no client secret), so it is not a secret. A Client ID saved in
// Settings overrides it; clearing it there leaves the app with no Client ID.
export const DEFAULT_CLIENT_ID = '4eb4571f6v3hnf1xdwwxxetk3uc5cx';

// Every scope Lurkbox may ever need, requested once at sign-in so the user
// only authorizes one time. v0.1 only uses user:read:follows (chat is
// anonymous IRC). A stored token missing any of these prompts a new sign-in.
export const SCOPES = [
  'user:read:follows',
  'user:read:subscriptions',
  'user:read:emotes',
  'user:read:blocked_users',
  'user:manage:blocked_users',
  'user:read:chat',
  'user:write:chat',
  'chat:read',
  'chat:edit',
  'user:manage:whispers',
  'clips:edit',
];
