import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from './env.js';
import { Store, hashSecret, normalizeSettings } from './store.js';
import { acceptChatMessage, TokenBucket } from './music.js';
import { authorizationUrl, exchangeCode, EventSubClient, getIdentity, refreshToken, revokeToken, validateToken } from './twitch.js';

let config;
try { config = loadConfig(); }
catch (error) { process.stderr.write(`Pulse Choir configuration error: ${error.message}\n`); process.exit(1); }

const store = new Store(config.dataDir, config.encryptionKey);
await store.init();
const root = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const server = createServer(handleHttp);
const overlaySockets = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 2048, perMessageDeflate: false, handleProtocols: (protocols) => protocols.has('pulse-overlay') ? 'pulse-overlay' : false });
const authStates = new Map();
const overlayTickets = new Map();
const runtimes = new Map();
const eventClients = new Map();
const refreshTimers = new Map();
const refreshGenerations = new Map();
const validationTimers = new Map();
const tokenRefreshes = new Map();
const requestCounts = new Map();
const MAX_BODY = 8192;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function runtime(id) {
  if (!runtimes.has(id)) runtimes.set(id, { state: 'disconnected', detail: 'Connect your Twitch channel to start.', events: [], beatOrigin: Date.now(), cooldowns: new Map(), limiter: new TokenBucket(), pipeline: Promise.resolve(), overflow: 0 });
  return runtimes.get(id);
}
function scheduleRefresh(id, expiresAt) {
  const generation = (refreshGenerations.get(id) || 0) + 1;
  refreshGenerations.set(id, generation);
  clearTimeout(refreshTimers.get(id));
  const wait = Math.max(1000, expiresAt - Date.now() - 120_000);
  refreshTimers.set(id, setTimeout(async () => {
    if (refreshGenerations.get(id) !== generation) return;
    try {
      await getAccessToken(id);
      if (refreshGenerations.get(id) !== generation || !store.get(id)) return;
      scheduleRefresh(id, store.token(id).expires_at);
      eventClients.get(id)?.close(); eventClients.delete(id);
      startConnection(id);
    } catch {
      if (refreshGenerations.get(id) !== generation || !store.get(id)) return;
      const tenant = store.get(id);
      if (tenant?.needsReauth) return;
      updateStatus(id, 'error', 'Twitch token refresh could not reach the authorization service. Retrying shortly.');
      scheduleRefresh(id, Date.now() + 150_000);
    }
  }, wait));
}
function scheduleValidation(id, delay = 55 * 60_000) {
  clearTimeout(validationTimers.get(id));
  validationTimers.set(id, setTimeout(async () => {
    if (!store.get(id) || store.get(id).needsReauth) return;
    try {
      const token = await getAccessToken(id);
      const profile = await validateToken(token, config.clientId);
      if (profile.user_id !== id || !profile.scopes.includes('user:read:chat')) throw Object.assign(new Error('Twitch authorization no longer has the required chat permission.'), { status: 403 });
      await store.update(id, { lastValidatedAt: Date.now() });
      scheduleValidation(id);
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) await markReauthRequired(id, 'Twitch authorization expired, was revoked, or no longer has chat permission. Reconnect your account.');
      else {
        updateStatus(id, 'error', 'Twitch authorization could not be checked. Retrying shortly.');
        scheduleValidation(id, 60_000);
      }
    }
  }, delay));
}
function signature(value) { return createHmac('sha256', config.sessionSecret).update(value).digest('base64url'); }
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}
function sessionId(req) {
  const value = cookie(req, 'pc_session');
  const [id, expires, version, mac, extra] = (value || '').split('.');
  if (!id || !expires || !version || !mac || extra || !/^\d{1,30}$/.test(id) || !/^\d+$/.test(expires) || !/^\d+$/.test(version) || Number(expires) < Date.now()) return null;
  const expected = Buffer.from(signature(`${id}.${expires}.${version}`)); const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const tenant = store.get(id);
  return tenant && !tenant.needsReauth && tenant.sessionVersion === Number(version) ? id : null;
}
function signedSessionNeedsReauth(req) {
  const [id, expires, version, mac, extra] = (cookie(req, 'pc_session') || '').split('.');
  if (!id || !expires || !version || !mac || extra || !/^\d{1,30}$/.test(id) || !/^\d+$/.test(expires) || !/^\d+$/.test(version) || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(signature(`${id}.${expires}.${version}`)); const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  const tenant = store.get(id);
  return Boolean(tenant?.needsReauth && Number(version) < tenant.sessionVersion);
}
function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value);
}
function setSession(res, id) {
  const version = String(store.get(id)?.sessionVersion || 0);
  const expires = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const value = `${id}.${expires}.${version}.${signature(`${id}.${expires}.${version}`)}`;
  appendCookie(res, `pc_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${config.production ? '; Secure' : ''}`);
}
function clearSession(res) { appendCookie(res, `pc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.production ? '; Secure' : ''}`); }
function setOAuthCookie(res, state) { appendCookie(res, `pc_oauth=${state}; Path=/auth/twitch/callback; HttpOnly; SameSite=Lax; Max-Age=600${config.production ? '; Secure' : ''}`); }
function clearOAuthCookie(res) { appendCookie(res, `pc_oauth=; Path=/auth/twitch/callback; HttpOnly; SameSite=Lax; Max-Age=0${config.production ? '; Secure' : ''}`); }
function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}
function safeStatus(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; media-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
}
function originAllowed(req) { return req.headers.origin === config.origin; }
function requireOrigin(req, res) { if (!originAllowed(req)) { send(res, 403, { error: 'Request origin is not allowed.' }); return false; } return true; }
function requireOwner(req, res) {
  const id = sessionId(req);
  if (!id) { send(res, 401, { error: 'Connect your Twitch account to use streamer controls.' }); return null; }
  return id;
}
function publish(id, message) {
  for (const client of overlaySockets.clients) {
    if (client.readyState === WebSocket.OPEN && client.tenantId === id) {
      if (client.bufferedAmount > 128 * 1024) { client.close(1013, 'Slow overlay client'); continue; }
      client.send(JSON.stringify(message));
    }
  }
}
function viewState(id) {
  const t = store.get(id); const r = runtime(id);
  if (!t) return null;
  return {
    channel: { login: t.owner.login, name: t.owner.name }, settings: t.settings,
    running: t.running, muted: t.muted, sequence: t.sequence,
    connection: { state: r.state, detail: r.detail }, events: r.events.slice(-16),
    beatOrigin: r.beatOrigin, serverNow: Date.now(), overload: r.overflow,
  };
}
function updateStatus(id, state, detail) {
  const r = runtime(id); r.state = state; r.detail = String(detail).slice(0, 240);
  publish(id, { type: 'state', state: viewState(id) });
}
async function markReauthRequired(id, detail) {
  const tenant = store.get(id);
  if (!tenant) return;
  if (!tenant.needsReauth) await store.update(id, { needsReauth: true, running: false, sessionVersion: (tenant.sessionVersion || 0) + 1 });
  clearTimeout(refreshTimers.get(id)); refreshTimers.delete(id);
  clearTimeout(validationTimers.get(id)); validationTimers.delete(id);
  const client = eventClients.get(id); client?.close(); eventClients.delete(id);
  updateStatus(id, 'permission_denied', detail || 'Twitch authorization expired or was revoked. Reconnect your account.');
}
async function getAccessToken(id, forceRefresh = false) {
  const tokens = store.token(id);
  if (!tokens?.refresh_token) throw new Error('Twitch connection has no refresh token. Reconnect Twitch.');
  if (!forceRefresh && tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (tokenRefreshes.has(id)) return tokenRefreshes.get(id);
  const task = (async () => {
    const latest = store.token(id);
    if (!latest) throw new Error('Twitch channel was disconnected.');
    if (!forceRefresh && latest.expires_at > Date.now() + 60_000) return latest.access_token;
  try {
    const fresh = await refreshToken({ refreshToken: latest.refresh_token, clientId: config.clientId, clientSecret: config.clientSecret });
    const profile = await validateToken(fresh.access_token, config.clientId);
    if (profile.user_id !== id) throw new Error('Refreshed Twitch token belongs to another account.');
    const owner = store.get(id).owner;
    const expiresAt = Date.now() + fresh.expires_in * 1000;
    await store.putTenant(owner, { ...fresh, expires_at: expiresAt });
    return fresh.access_token;
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) await markReauthRequired(id, 'Twitch refresh token expired or was revoked. Reconnect your account.');
    else updateStatus(id, 'error', 'Twitch token could not be refreshed. Reconnect your account.');
    throw error;
  }
  })();
  tokenRefreshes.set(id, task);
  try { return await task; }
  finally { if (tokenRefreshes.get(id) === task) tokenRefreshes.delete(id); }
}
function startConnection(id) {
  if (eventClients.has(id)) return;
  if (store.get(id)?.needsReauth) return updateStatus(id, 'permission_denied', 'Reconnect Twitch to resume chat.');
  const client = new EventSubClient({
    tenantId: id, clientId: config.clientId, getToken: (force) => getAccessToken(id, force),
    onStatus: (state, detail) => {
      if (state === 'revoked' || state === 'permission_denied') void markReauthRequired(id, detail);
      else updateStatus(id, state, detail);
    },
    onEvent: (eventId, event, timestamp) => processChat(id, eventId, event, timestamp),
  });
  eventClients.set(id, client); client.start();
}
async function processChat(id, eventId, event, timestamp) {
  const r = runtime(id);
  r.pipeline = r.pipeline.then(async () => {
    const t = store.get(id);
    if (!t || !t.running || r.persistenceFailed) return;
    const eventTime = Date.parse(timestamp);
    if (!Number.isFinite(eventTime) || eventTime > Date.now() + 30_000 || Date.now() - eventTime > 120_000) return;
    if (!t.recentMessageIds.includes(eventId) && event?.message?.text && !/^!pulse(?:\s|$)/i.test(event.message.text)) return;
    if (t.recentMessageIds.includes(eventId)) return;
    const now = Date.now();
    const pending = r.events.filter((item) => item.beatAt > now).length;
    if (pending >= 32) { r.overflow += 1; publish(id, { type: 'state', state: viewState(id) }); return; }
    const result = acceptChatMessage({ tenant: { ...t, beatOrigin: r.beatOrigin, sequence: t.sequence }, event, eventId, now, cooldowns: r.cooldowns, globalLimiter: r.limiter });
    const recentMessageIds = [...t.recentMessageIds, eventId].slice(-2000);
    await store.update(id, { recentMessageIds });
    if (!result.accepted) return;
    await store.update(id, { sequence: result.event.sequence });
    r.events = [...r.events.filter((item) => item.beatAt > now - 5000), result.event].slice(-32);
    publish(id, { type: 'note', event: result.event, state: viewState(id) });
  }).catch(() => { r.persistenceFailed = true; updateStatus(id, 'error', 'Pulse Choir could not safely save a chat event. Restart the service after repairing persistent storage.'); });
  return r.pipeline;
}
function currentHost(req, res, callback) {
  const id = requireOwner(req, res); if (!id) return;
  const t = store.get(id); if (!t) { send(res, 401, { error: 'Twitch channel is no longer connected.' }); return; }
  callback(id, t);
}
function requestLimit(req, res) {
  const ip = req.socket.remoteAddress || 'unknown'; const now = Date.now();
  let item = requestCounts.get(ip);
  if (!item || now - item.since > 60_000) item = { since: now, count: 0 };
  item.count += 1; requestCounts.set(ip, item);
  if (requestCounts.size > 5000) for (const [key, value] of requestCounts) if (now - value.since > 120_000) requestCounts.delete(key);
  if (item.count > 120) { send(res, 429, { error: 'Request limit reached. Try again shortly.' }); return false; }
  return true;
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('Request body is too large.'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('Request body must be valid JSON.'); }
}
async function handleHttp(req, res) {
  safeStatus(req, res, () => {});
  if (!requestLimit(req, res)) return;
  let url;
  try { url = new URL(req.url, config.origin); } catch { return send(res, 400, { error: 'Invalid request URL.' }); }
  const path = url.pathname;
  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, service: 'pulse-choir', configured: true });
  if (req.method === 'GET' && path === '/auth/twitch') {
    const now = Date.now();
    for (const [key, expiry] of authStates) if (expiry < now) authStates.delete(key);
    if (authStates.size > 5000) return send(res, 429, { error: 'Twitch sign-in is busy. Try again shortly.' });
    const state = randomBytes(32).toString('base64url'); authStates.set(state, now + 10 * 60_000);
    setOAuthCookie(res, state);
    res.writeHead(302, { Location: authorizationUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state }), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
  }
  if (req.method === 'GET' && path === '/auth/twitch/callback') {
    const state = url.searchParams.get('state'); const expires = authStates.get(state);
    if (!state || !expires || expires < Date.now() || cookie(req, 'pc_oauth') !== state) { clearOAuthCookie(res); return send(res, 400, { error: 'Twitch sign-in state is missing, expired, or already used. Start again.' }); }
    authStates.delete(state);
    if (url.searchParams.has('error')) { clearOAuthCookie(res); res.writeHead(303, { Location: '/?auth_error=denied', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end(); }
    const code = url.searchParams.get('code'); if (!code || code.length > 2048) return send(res, 400, { error: 'Twitch did not return a valid authorization code.' });
    try {
      const tokens = await exchangeCode({ code, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
      const profile = await validateToken(tokens.access_token, config.clientId);
      const owner = await getIdentity({ token: tokens.access_token, clientId: config.clientId });
      if (profile.user_id !== owner.id) throw new Error('OAuth identity and Twitch profile do not match.');
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await store.putTenant(owner, { ...tokens, expires_at: expiresAt }); scheduleRefresh(owner.id, expiresAt);
      const prior = eventClients.get(owner.id); prior?.close(); eventClients.delete(owner.id);
      const r = runtime(owner.id); r.state = 'connecting'; r.detail = 'Connecting to Twitch chat.'; r.events = []; r.beatOrigin = Date.now();
      scheduleValidation(owner.id);
      setSession(res, owner.id); clearOAuthCookie(res); res.writeHead(303, { Location: '/dashboard', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
      startConnection(owner.id);
    } catch { clearOAuthCookie(res); res.writeHead(303, { Location: '/?auth_error=failed', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); }
    return;
  }
  if (path.startsWith('/api/')) {
    if (req.method !== 'GET' && !requireOrigin(req, res)) return;
    try { return await api(req, res, path); }
    catch (error) { return send(res, error.status || 400, { error: String(error.message || 'Request failed.').slice(0, 220) }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  let file = path === '/' || path === '/dashboard' ? 'index.html' : path === '/overlay' ? 'overlay.html' : path.slice(1);
  if (!file || file.includes('..') || file.includes('\\') || file.includes('\0')) return send(res, 404, 'Not found.');
  const absolute = resolve(root, file);
  if (!absolute.startsWith(root + sep)) return send(res, 404, 'Not found.');
  try {
    const bytes = await readFile(absolute);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    res.end(bytes);
  } catch { send(res, 404, 'Not found.'); }
}

async function api(req, res, path) {
  if (req.method === 'GET' && path === '/api/me') {
    const id = sessionId(req); const t = id && store.get(id);
    const response = { connected: !!t, owner: t?.owner || null, state: t ? viewState(id) : null, overlayReady: !!t?.overlayHash };
    if (!id && signedSessionNeedsReauth(req)) response.reauthorizationRequired = true;
    return send(res, 200, response);
  }
  if (req.method === 'POST' && path === '/api/overlay/exchange') {
    const body = await readJson(req); const key = body?.key;
    if (typeof key !== 'string' || key.length < 40 || key.length > 100) return send(res, 401, { error: 'Overlay key is invalid or revoked.' });
    const digest = hashSecret(key);
    const id = store.list().find((tenantId) => store.get(tenantId)?.overlayHash === digest);
    if (!id) return send(res, 401, { error: 'Overlay key is invalid or revoked.' });
    const now = Date.now();
    for (const [ticketHash, item] of overlayTickets) if (item.expires < now) overlayTickets.delete(ticketHash);
    if (overlayTickets.size > 10_000) return send(res, 429, { error: 'Too many overlay connections. Try again shortly.' });
    const ticket = randomBytes(32).toString('base64url'); overlayTickets.set(hashSecret(ticket), { id, expires: now + 60_000 });
    return send(res, 200, { ticket });
  }
  const ownerId = requireOwner(req, res); if (!ownerId) return;
  const tenant = store.get(ownerId);
  if (req.method === 'GET' && path === '/api/state') return send(res, 200, viewState(ownerId));
  if (req.method === 'POST' && path === '/api/settings') {
    const body = await readJson(req); const settings = normalizeSettings(body);
    await store.update(ownerId, { settings }); runtime(ownerId).beatOrigin = Date.now();
    publish(ownerId, { type: 'state', state: viewState(ownerId) }); return send(res, 200, viewState(ownerId));
  }
  if (req.method === 'POST' && path === '/api/start') {
    await store.update(ownerId, { running: true }); runtime(ownerId).beatOrigin = Date.now();
    if (!eventClients.has(ownerId)) startConnection(ownerId);
    publish(ownerId, { type: 'state', state: viewState(ownerId) }); return send(res, 200, viewState(ownerId));
  }
  if (req.method === 'POST' && path === '/api/pause') {
    await store.update(ownerId, { running: false }); publish(ownerId, { type: 'state', state: viewState(ownerId) }); return send(res, 200, viewState(ownerId));
  }
  if (req.method === 'POST' && path === '/api/mute') {
    await store.update(ownerId, { muted: !tenant.muted }); publish(ownerId, { type: 'state', state: viewState(ownerId) }); return send(res, 200, viewState(ownerId));
  }
  if (req.method === 'POST' && path === '/api/clear') {
    const r = runtime(ownerId); r.events = []; r.beatOrigin = Date.now(); publish(ownerId, { type: 'clear', state: viewState(ownerId) }); return send(res, 200, viewState(ownerId));
  }
  if (req.method === 'POST' && path === '/api/overlay-key') {
    const key = randomBytes(32).toString('base64url'); await store.update(ownerId, { overlayHash: hashSecret(key) });
    for (const client of overlaySockets.clients) if (client.tenantId === ownerId) client.close(4001, 'Overlay key rotated');
    const overlayUrl = `${config.origin}/overlay#${key}`;
    publish(ownerId, { type: 'state', state: viewState(ownerId) }); return send(res, 200, { url: overlayUrl });
  }
  if (req.method === 'POST' && path === '/api/disconnect') {
    const tokens = store.token(ownerId); eventClients.get(ownerId)?.close(); eventClients.delete(ownerId);
    for (const client of overlaySockets.clients) if (client.tenantId === ownerId) client.close(4001, 'Channel disconnected');
    let revoked = true;
    try { await revokeToken({ token: tokens.access_token, clientId: config.clientId }); } catch { revoked = false; }
    clearTimeout(refreshTimers.get(ownerId)); refreshTimers.delete(ownerId);
    clearTimeout(validationTimers.get(ownerId)); validationTimers.delete(ownerId);
    refreshGenerations.delete(ownerId); tokenRefreshes.delete(ownerId);
    await store.remove(ownerId); runtimes.delete(ownerId); clearSession(res);
    return send(res, 200, { disconnected: true, twitchRevocationConfirmed: revoked });
  }
  return send(res, 404, { error: 'Unknown Pulse Choir endpoint.' });
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  let url;
  try { url = new URL(req.url, config.origin); } catch { socket.destroy(); return; }
  if (url.pathname !== '/live' || req.headers.origin !== config.origin) { socket.destroy(); return; }
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((part) => part.trim());
  const credential = offered.find((part) => part.startsWith('pulse-ticket.'));
  const hash = credential?.slice('pulse-ticket.'.length);
  if (!offered.includes('pulse-overlay')) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  const item = hash && overlayTickets.get(hashSecret(hash));
  if (!item || item.expires < Date.now()) { if (hash) overlayTickets.delete(hashSecret(hash)); socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  overlayTickets.delete(hashSecret(hash));
  const tenantSockets = [...overlaySockets.clients].filter((client) => client.tenantId === item.id).length;
  if (tenantSockets >= 10 || overlaySockets.clients.size >= 2000) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  overlaySockets.handleUpgrade(req, socket, head, (client) => {
    client.tenantId = item.id;
    client.on('error', () => {});
    client.on('message', () => client.close(1008, 'Overlay is read-only'));
    client.send(JSON.stringify({ type: 'state', state: viewState(item.id) }));
  });
});

for (const id of store.list()) {
  const r = runtime(id); r.state = 'connecting'; r.detail = 'Restoring Twitch connection.';
  scheduleValidation(id);
  scheduleRefresh(id, store.token(id).expires_at || Date.now());
  getAccessToken(id).then((token) => validateToken(token, config.clientId)).then((profile) => {
    if (profile.user_id !== id) throw new Error('Twitch token account mismatch.');
    return store.update(id, { lastValidatedAt: Date.now() });
  }).then(() => {
    startConnection(id);
  }).catch((error) => {
    if ([400, 401, 403].includes(error.status)) void markReauthRequired(id, 'Saved Twitch authorization is invalid or revoked. Reconnect the channel.');
    else updateStatus(id, 'error', 'Saved Twitch authorization could not be checked. Retrying shortly.');
  });
}

server.listen(config.port, '0.0.0.0', () => process.stdout.write(`Pulse Choir ready on port ${config.port}; tenants=${store.list().length}\n`));

async function shutdown() {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  for (const timer of validationTimers.values()) clearTimeout(timer);
  for (const client of eventClients.values()) client.close();
  for (const client of overlaySockets.clients) client.close(1001, 'Server shutting down');
  await store.persist(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
