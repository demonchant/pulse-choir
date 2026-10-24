import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const DEFAULT_SETTINGS = Object.freeze({ tempo: 96, key: 'C', scale: 'major', octave: 4, volume: 55, audience: 'everyone' });
const clone = (value) => structuredClone(value);

export function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') };
}
export function unseal(record, key) {
  if (record?.v !== 1) throw new Error('Unsupported encrypted token record.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64url')), decipher.final()]).toString('utf8'));
}

export const hashSecret = (value) => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(dir, key) { this.dir = dir; this.path = join(dir, 'pulse-choir.json'); this.key = key; this.data = { tenants: {} }; this.writeChain = Promise.resolve(); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const body = JSON.parse(await readFile(this.path, 'utf8'));
      if (!body || body.v !== 1 || !body.tenants || typeof body.tenants !== 'object' || Array.isArray(body.tenants)) throw new Error('Invalid store format.');
      this.data = body;
      for (const [id, t] of Object.entries(this.data.tenants)) {
        if (!/^\d{1,30}$/.test(id) || t.owner?.id !== id || !t.token || t.overlayHash !== null && typeof t.overlayHash !== 'string') throw new Error('Invalid tenant record.');
        unseal(t.token, this.key);
        t.settings = normalizeSettings(t.settings);
        t.recentMessageIds = Array.isArray(t.recentMessageIds) ? t.recentMessageIds.slice(-2000) : [];
        t.needsReauth = Boolean(t.needsReauth);
        t.sessionVersion = Number.isSafeInteger(t.sessionVersion) && t.sessionVersion >= 0 ? t.sessionVersion : 0;
        t.lastValidatedAt = Number.isFinite(t.lastValidatedAt) ? t.lastValidatedAt : null;
        if (typeof t.running !== 'boolean' || typeof t.muted !== 'boolean' || !Number.isSafeInteger(t.sequence) || t.sequence < 0) throw new Error('Invalid tenant state.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Pulse Choir store cannot be loaded safely: ${error.message}`);
    }
  }
  get(id) { const t = this.data.tenants[id]; return t ? clone(t) : null; }
  token(id) { const t = this.data.tenants[id]; return t ? unseal(t.token, this.key) : null; }
  list() { return Object.keys(this.data.tenants); }
  async putTenant(owner, tokens) {
    const id = owner.id;
    const previous = this.data.tenants[id];
    this.data.tenants[id] = {
      owner: { id, login: owner.login, name: owner.name }, token: seal(tokens, this.key),
      settings: previous?.settings || { ...DEFAULT_SETTINGS }, overlayHash: previous?.overlayHash || null,
      running: previous?.running ?? true, muted: previous?.muted ?? false,
      needsReauth: false, sessionVersion: previous?.sessionVersion || 0, lastValidatedAt: previous?.lastValidatedAt || null,
      sequence: previous?.sequence || 0, recentMessageIds: previous?.recentMessageIds || [],
      createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }
  async update(id, patch) {
    const t = this.data.tenants[id]; if (!t) throw new Error('Channel is not connected.');
    Object.assign(t, patch, { updatedAt: new Date().toISOString() }); await this.persist();
  }
  async remove(id) { delete this.data.tenants[id]; await this.persist(); }
  async persist() {
    const serialized = JSON.stringify({ v: 1, tenants: this.data.tenants });
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.writeChain;
  }
}

export function normalizeSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Settings must be an object.');
  if (Object.keys(s).sort().join(',') !== 'audience,key,octave,scale,tempo,volume') throw new Error('Settings contain missing or unexpected fields.');
  const { tempo, key, scale, octave, volume, audience } = s;
  if (!Number.isInteger(tempo) || tempo < 60 || tempo > 180) throw new Error('Tempo must be 60–180 BPM.');
  if (!['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].includes(key)) throw new Error('Choose a supported musical key.');
  if (!['major', 'minor', 'pentatonic'].includes(scale)) throw new Error('Choose a supported scale.');
  if (!Number.isInteger(octave) || octave < 2 || octave > 5) throw new Error('Octave must be from 2 to 5.');
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('Volume must be 0–100.');
  if (!['everyone', 'subs', 'mods'].includes(audience)) throw new Error('Choose who may participate.');
  return { tempo, key, scale, octave, volume, audience };
}
