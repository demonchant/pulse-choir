import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, normalizeSettings, seal, unseal, hashSecret } from '../server/store.js';

const key = Buffer.alloc(32, 113);
const tokens = (value) => ({ access_token: `access-${value}`, refresh_token: `refresh-${value}`, expires_at: Date.now() + 3600_000 });

test('AES-256-GCM token envelope decrypts only with the correct key and detects tampering', () => {
  const envelope = seal(tokens('one'), key);
  assert.equal(unseal(envelope, key).refresh_token, 'refresh-one');
  assert.notEqual(envelope.data, JSON.stringify(tokens('one')));
  assert.throws(() => unseal(envelope, Buffer.alloc(32, 114)));
  assert.throws(() => unseal({ ...envelope, data: `${envelope.data.slice(0, -1)}A` }, key));
});

test('tenant ownership and encrypted token persistence survive a process restart without cross-channel reads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-choir-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Store(dir, key); await first.init();
  await first.putTenant({ id: '101', login: 'alpha', name: 'Alpha' }, tokens('alpha'));
  await first.putTenant({ id: '202', login: 'beta', name: 'Beta' }, tokens('beta'));
  await first.update('101', { running: false, sequence: 9, overlayHash: hashSecret('overlay-a') });
  assert.equal(first.token('101').refresh_token, 'refresh-alpha');
  assert.equal(first.get('202').owner.login, 'beta');
  assert.equal(first.get('202').overlayHash, null);
  const second = new Store(dir, key); await second.init();
  assert.deepEqual(second.list().sort(), ['101', '202']);
  assert.equal(second.get('101').running, false); assert.equal(second.get('101').sequence, 9);
  assert.equal(second.token('202').refresh_token, 'refresh-beta');
  assert.equal(second.get('101').owner.id, '101');
});

test('settings reject invalid ranges and unexpected enum values', () => {
  const ok = { tempo: 60, key: 'Eb', scale: 'minor', octave: 2, volume: 0, audience: 'mods' };
  assert.deepEqual(normalizeSettings(ok), ok);
  for (const bad of [
    { ...ok, tempo: 59 }, { ...ok, tempo: 181 }, { ...ok, key: 'H' }, { ...ok, scale: 'chromatic' },
    { ...ok, octave: 6 }, { ...ok, volume: 101 }, { ...ok, audience: 'everyone,mods' },
  ]) assert.throws(() => normalizeSettings(bad));
  assert.throws(() => normalizeSettings({ ...ok, label: '<script>' }));
});
