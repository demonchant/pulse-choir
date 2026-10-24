import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptChatMessage, mapNote, nextBeat, parseCommand, TokenBucket } from '../server/music.js';

const settings = { tempo: 120, key: 'C', scale: 'major', octave: 4, volume: 55, audience: 'everyone' };
const event = (id, text = '!pulse 1', extras = {}) => ({ broadcaster_user_id: '100', chatter_user_id: id, message: { text }, badges: [], ...extras });

test('command grammar is strict, bounded, and accepts only documented choices', () => {
  assert.deepEqual(parseCommand('!pulse 1'), { kind: 'note', degree: 1 });
  assert.deepEqual(parseCommand('!PULSE 7'), { kind: 'note', degree: 7 });
  assert.deepEqual(parseCommand('!pulse clap'), { kind: 'clap' });
  for (const input of ['!pulse 0', '!pulse 8', '!pulse 1 extra', '!pulse clap now', 'hello !pulse 1', '!pulse', `!pulse ${'1'.repeat(110)}`]) assert.equal(parseCommand(input), null, input);
});
test('scale mapping yields deterministic equal-tempered notes and bounded frequency', () => {
  const first = mapNote(parseCommand('!pulse 1'), settings);
  assert.deepEqual({ label: first.label, midi: first.midi, frequency: first.frequency }, { label: 'C4', midi: 60, frequency: 261.6255653005986 });
  const last = mapNote(parseCommand('!pulse 7'), settings);
  assert.equal(last.label, 'B4'); assert.ok(last.frequency < 1400);
  assert.equal(mapNote(parseCommand('!pulse 1'), { ...settings, key: 'A', scale: 'minor', octave: 3 }).label, 'A3');
  assert.equal(mapNote(parseCommand('!pulse 1'), { ...settings, scale: 'pentatonic' }).label, 'C4');
  assert.equal(mapNote(parseCommand('!pulse clap'), settings).frequency, null);
});
test('beat scheduling uses a stable phase and leaves lead time for overlay delivery', () => {
  assert.equal(nextBeat(1000, 120, 0, 500), 1500);
  assert.equal(nextBeat(1001, 120, 0, 500), 2000);
  assert.equal(nextBeat(1900, 60, 1000, 500), 3000);
});
test('chat acceptance enforces tenant, audience, per-viewer cooldown and message shape', () => {
  const cooldowns = new Map(); const limiter = new TokenBucket({ capacity: 20, periodMs: 10_000 });
  const tenant = { owner: { id: '100' }, settings, sequence: 1, beatOrigin: 0 };
  const good = acceptChatMessage({ tenant, event: event('200'), eventId: 'm1', now: 2000, cooldowns, globalLimiter: limiter });
  assert.equal(good.accepted, true); assert.equal(good.event.sequence, 2); assert.equal(good.event.label, 'C4');
  assert.equal(acceptChatMessage({ tenant, event: event('200'), eventId: 'm2', now: 2500, cooldowns, globalLimiter: limiter }).reason, 'cooldown');
  assert.equal(acceptChatMessage({ tenant, event: event('300', '!pulse 1', { broadcaster_user_id: '999' }), eventId: 'm3', now: 4000, cooldowns, globalLimiter: limiter }).reason, 'invalid_event');
  assert.equal(acceptChatMessage({ tenant, event: event('not-numeric'), eventId: 'm4', now: 4000, cooldowns, globalLimiter: limiter }).reason, 'invalid_event');
  assert.equal(acceptChatMessage({ tenant, event: event('400', '!pulse 1', { message: { text: 'x'.repeat(501) } }), eventId: 'm5', now: 4000, cooldowns, globalLimiter: limiter }).reason, 'invalid_message');
});
test('subscriber/moderator participation policy is enforced from Twitch badges', () => {
  const limiter = new TokenBucket();
  const tenant = { owner: { id: '100' }, settings: { ...settings, audience: 'subs' }, sequence: 0, beatOrigin: 0 };
  const base = { tenant, eventId: 'a', now: 2000, cooldowns: new Map(), globalLimiter: limiter };
  assert.equal(acceptChatMessage({ ...base, event: event('201') }).reason, 'audience_restricted');
  assert.equal(acceptChatMessage({ ...base, event: event('202', '!pulse 2', { badges: [{ set_id: 'subscriber' }] }) }).accepted, true);
  tenant.settings.audience = 'mods';
  assert.equal(acceptChatMessage({ ...base, event: event('203', '!pulse 3', { badges: [{ set_id: 'subscriber' }] }) }).reason, 'audience_restricted');
  assert.equal(acceptChatMessage({ ...base, event: event('204', '!pulse 3', { badges: [{ set_id: 'moderator' }] }) }).accepted, true);
});
test('global token bucket rejects floods and refills deterministically', () => {
  const limiter = new TokenBucket({ capacity: 2, periodMs: 10_000 });
  assert.equal(limiter.take(100), true); assert.equal(limiter.take(101), true); assert.equal(limiter.take(102), false);
  assert.equal(limiter.take(5102), true);
});
