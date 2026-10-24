import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

let proc; let base; let origin; let dataDir;
async function freePort() {
  const server = createTcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function waitForApp() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Pulse Choir exited during startup (${proc.exitCode}).`);
    try { const response = await fetch(`${base}/healthz`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proc.kill(); throw new Error('Pulse Choir did not become healthy within 10 seconds.');
}

const port = await freePort();
origin = `http://localhost:${port}`; base = origin;
dataDir = await mkdtemp(join(tmpdir(), 'pulse-choir-http-'));
const testKey = Buffer.alloc(32, 91).toString('base64url');
proc = spawn(process.execPath, ['--env-file-if-exists=.env.pulse-choir', 'server/index.js'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: origin, TWITCH_REDIRECT_URI: `${origin}/auth/twitch/callback`, TWITCH_CLIENT_ID: 'local-only-test-client-id', TWITCH_CLIENT_SECRET: 'not-a-real-twitch-secret', SESSION_SECRET: testKey, TOKEN_ENCRYPTION_KEY: testKey, DATA_DIR: dataDir },
});
let stderr = '';
proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
await waitForApp();

after(async () => {
  if (proc?.exitCode === null) { proc.kill(); await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]); }
  await rm(dataDir, { recursive: true, force: true });
});

test('health and static product routes are real HTTP responses with no fabricated connection', async () => {
  const health = await fetch(`${base}/healthz`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true, service: 'pulse-choir', configured: true });
  const [home, dashboard, overlay, icon] = await Promise.all(['/','/dashboard','/overlay','/favicon.svg'].map((path) => fetch(`${base}${path}`)));
  assert.equal(home.status, 200); assert.match(await home.text(), /One chat\./);
  assert.equal(dashboard.status, 200); assert.equal(overlay.status, 200); assert.equal(icon.status, 200);
  const me = await (await fetch(`${base}/api/me`)).json();
  assert.deepEqual(me, { connected: false, owner: null, state: null, overlayReady: false });
});

test('OAuth redirect requests only chat read scope; state is browser-bound, one-use, and denial is visible', async () => {
  const start = await fetch(`${base}/auth/twitch`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const redirect = new URL(start.headers.get('location'));
  assert.equal(redirect.origin, 'https://id.twitch.tv');
  assert.equal(redirect.searchParams.get('scope'), 'user:read:chat');
  const state = redirect.searchParams.get('state'); assert.equal(state.length, 43);
  const setCookie = start.headers.get('set-cookie');
  const oauthCookie = setCookie.match(/pc_oauth=([^;]+)/)?.[1]; assert.equal(oauthCookie, state);
  const mismatch = await fetch(`${base}/auth/twitch/callback?state=${state}&error=access_denied`, { redirect: 'manual' });
  assert.equal(mismatch.status, 400);
  const denied = await fetch(`${base}/auth/twitch/callback?state=${state}&error=access_denied`, { redirect: 'manual', headers: { Cookie: `pc_oauth=${state}` } });
  assert.equal(denied.status, 303); assert.equal(denied.headers.get('location'), '/?auth_error=denied');
  const replay = await fetch(`${base}/auth/twitch/callback?state=${state}&error=access_denied`, { redirect: 'manual', headers: { Cookie: `pc_oauth=${state}` } });
  assert.equal(replay.status, 400);
});

test('controls reject cross-site origins and unauthenticated owners; overlay exchange rejects invalid keys', async () => {
  const crossSite = await fetch(`${base}/api/settings`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  const noOwner = await fetch(`${base}/api/settings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ tempo: 96, key: 'C', scale: 'major', octave: 4, volume: 55, audience: 'everyone' }) });
  assert.equal(noOwner.status, 401);
  const invalidKey = await fetch(`${base}/api/overlay/exchange`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'x'.repeat(43) }) });
  assert.equal(invalidKey.status, 401);
  const invalidJson = await fetch(`${base}/api/overlay/exchange`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalidJson.status, 400);
});

test('overlay WebSocket upgrade requires an unexpired single-use tenant ticket', async () => {
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/live`, ['pulse-overlay'], { headers: { Origin: origin }, handshakeTimeout: 2000 });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Missing-ticket WebSocket handshake did not fail.')); }, 3000);
    ws.on('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); resolve(response.statusCode); });
    ws.on('open', () => { clearTimeout(timer); ws.close(); reject(new Error('Overlay accepted a socket without a ticket.')); });
    ws.on('error', () => {});
  });
  assert.equal(result, 401);
});

test('service emitted no sensitive or chat-content log while serving unauthenticated paths', () => {
  assert.doesNotMatch(stderr, /access-|refresh-|Bearer |OAuth /i);
});
