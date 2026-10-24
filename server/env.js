import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const required = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_REDIRECT_URI', 'APP_ORIGIN', 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}. Set these values in .env.pulse-choir using the README Configuration table, then register the Twitch redirect URI.`);
  const origin = new URL(env.APP_ORIGIN);
  const redirect = new URL(env.TWITCH_REDIRECT_URI);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must be an absolute origin without path, query, or fragment.');
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires HTTPS.');
  if (origin.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('APP_ORIGIN must use HTTPS except on local loopback development.');
  if (redirect.origin !== origin.origin || redirect.pathname !== '/auth/twitch/callback' || redirect.search || redirect.hash) throw new Error('TWITCH_REDIRECT_URI must equal APP_ORIGIN/auth/twitch/callback exactly.');
  if (env.NODE_ENV === 'production' && !env.DATA_DIR?.trim()) throw new Error('Production requires DATA_DIR to point to persistent writable storage.');
  if (env.TWITCH_CLIENT_ID.length < 10 || env.TWITCH_CLIENT_SECRET.length < 10) throw new Error('Twitch client ID/secret format is invalid.');
  for (const key of ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
    let bytes;
    try { bytes = Buffer.from(env[key], 'base64url'); } catch { throw new Error(`${key} must be base64url-encoded random bytes.`); }
    if (bytes.length !== 32 || bytes.toString('base64url') !== env[key]) throw new Error(`${key} must be exactly 32 random bytes encoded as base64url.`);
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return Object.freeze({
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
    redirectUri: redirect.toString(),
    origin: origin.origin,
    sessionSecret: Buffer.from(env.SESSION_SECRET, 'base64url'),
    encryptionKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64url'),
    dataDir: resolve(env.DATA_DIR || './data'),
    port,
    production: env.NODE_ENV === 'production',
  });
}
