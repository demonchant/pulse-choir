import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChannelLogin, publicState } from '../server/public-state.js';

test('channel lookup accepts Twitch login syntax only and normalizes case', () => {
  assert.equal(normalizeChannelLogin('@Some_Channel9'), 'some_channel9');
  for (const value of ['two words', 'https://twitch.tv/a', '../a', '', 'x'.repeat(26), null]) assert.equal(normalizeChannelLogin(value), null);
});

test('public companion state contains musical information without identities, chat text, or credentials', () => {
  const tenant = { owner: { id: '123456', login: 'songmaker', name: 'Song Maker' }, settings: { tempo: 100, key: 'F', scale: 'minor', octave: 4, volume: 45, audience: 'everyone' }, running: true, muted: false, sequence: 8, accessToken: 'must-not-appear', refreshToken: 'must-not-appear' };
  const runtime = { state: 'connected', detail: 'internal detail', beatOrigin: 1_000, events: [{ id: 'private-event-id', sequence: 8, kind: 'note', degree: 3, label: 'Ab4', beatAt: 61_000, beatInBar: 4, receivedAt: 60_500, chatterId: 'private-viewer-id', message: '!pulse 3' }] };
  const output = publicState(tenant, runtime, 62_000);
  assert.deepEqual(output, {
    channel: { login: 'songmaker', name: 'Song Maker' }, settings: { tempo: 100, key: 'F', scale: 'minor' }, running: true, muted: false, sequence: 8,
    connection: { state: 'connected' }, events: [{ sequence: 8, kind: 'note', degree: 3, label: 'Ab4', beatAt: 61_000, receivedAt: 60_500, beatInBar: 4 }], serverNow: 62_000,
  });
  const serialized = JSON.stringify(output);
  for (const secret of ['private-event-id', 'private-viewer-id', '!pulse 3', 'must-not-appear', 'internal detail', 'accessToken', 'refreshToken']) assert.equal(serialized.includes(secret), false, secret);
});

test('public note history is bounded to the latest 32 entries', () => {
  const tenant = { owner: { id: '42', login: 'singer', name: 'Singer' }, settings: { tempo: 120, key: 'C', scale: 'major' }, running: true, muted: false, sequence: 40 };
  const runtime = { state: 'connected', beatOrigin: 0, events: Array.from({ length: 40 }, (_, index) => ({ sequence: index + 1, kind: 'note', degree: 1, label: 'C4', beatAt: index * 500, receivedAt: index * 500 })) };
  const output = publicState(tenant, runtime, 20_000);
  assert.equal(output.events.length, 32); assert.equal(output.events[0].sequence, 9); assert.equal(output.events.at(-1).sequence, 40);
});
