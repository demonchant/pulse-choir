import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/env.js';

const key = Buffer.alloc(32, 37).toString('base64url');
const valid = () => ({ TWITCH_CLIENT_ID: 'local-test-client-id', TWITCH_CLIENT_SECRET: 'not-a-real-secret', APP_ORIGIN: 'http://localhost:3000', TWITCH_REDIRECT_URI: 'http://localhost:3000/auth/twitch/callback', SESSION_SECRET: key, TOKEN_ENCRYPTION_KEY: key, NODE_ENV: 'test', PORT: '3000', DATA_DIR: './data' });

test('configuration fails closed with named missing credentials', () => {
  assert.throws(() => loadConfig({}), /TWITCH_CLIENT_ID.*TWITCH_CLIENT_SECRET.*TWITCH_REDIRECT_URI.*APP_ORIGIN.*SESSION_SECRET.*TOKEN_ENCRYPTION_KEY/);
});
test('configuration rejects noncanonical secrets, callback mismatch and unsafe public HTTP', () => {
  const shortKey = valid(); shortKey.SESSION_SECRET = 'short';
  assert.throws(() => loadConfig(shortKey), /exactly 32 random bytes/);
  const badCallback = valid(); badCallback.TWITCH_REDIRECT_URI = 'http://localhost:3000/other';
  assert.throws(() => loadConfig(badCallback), /must equal APP_ORIGIN/);
  const publicHttp = valid(); publicHttp.APP_ORIGIN = 'http://example.com'; publicHttp.TWITCH_REDIRECT_URI = 'http://example.com/auth/twitch/callback';
  assert.throws(() => loadConfig(publicHttp), /must use HTTPS/);
});
test('production requires TLS and explicit persistent storage', () => {
  const noData = { ...valid(), NODE_ENV: 'production', APP_ORIGIN: 'https://pulse.example', TWITCH_REDIRECT_URI: 'https://pulse.example/auth/twitch/callback', DATA_DIR: '' };
  assert.throws(() => loadConfig(noData), /requires DATA_DIR/);
  noData.DATA_DIR = '/var/data'; noData.APP_ORIGIN = 'http://pulse.example'; noData.TWITCH_REDIRECT_URI = 'http://pulse.example/auth/twitch/callback';
  assert.throws(() => loadConfig(noData), /requires HTTPS/);
});
