import WebSocket from 'ws';

const OAUTH = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const REQUIRED_SCOPE = 'user:read:chat';

export function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(`${OAUTH}/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: REQUIRED_SCOPE, state, force_verify: 'true' });
  return url.toString();
}

async function parseResponse(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.message || body.error_description || body.error || label).slice(0, 180);
    const error = new Error(`${label} failed (${response.status}): ${message}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const response = await fetch(`${OAUTH}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }) });
  const body = await parseResponse(response, 'Twitch OAuth code exchange');
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || !Number.isInteger(body.expires_in) || !body.scope?.includes(REQUIRED_SCOPE)) throw new Error('Twitch returned an incomplete token or omitted user:read:chat. Reconnect and grant the requested scope.');
  return body;
}

export async function refreshToken({ refreshToken, clientId, clientSecret }) {
  const response = await fetch(`${OAUTH}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) });
  const body = await parseResponse(response, 'Twitch OAuth token refresh');
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || !Number.isInteger(body.expires_in)) throw new Error('Twitch returned an incomplete refreshed token. Reconnect Twitch.');
  return body;
}

export async function validateToken(token, clientId) {
  const response = await fetch(`${OAUTH}/validate`, { headers: { Authorization: `OAuth ${token}` } });
  const body = await parseResponse(response, 'Twitch token validation');
  if (body.client_id !== clientId || typeof body.user_id !== 'string') throw new Error('Twitch token belongs to a different application or has no user identity.');
  if (!Array.isArray(body.scopes) || !body.scopes.includes(REQUIRED_SCOPE)) throw new Error('Twitch authorization is missing user:read:chat. Reconnect and grant the requested permission.');
  return body;
}

async function helix(path, token, clientId, options = {}) {
  const response = await fetch(`${HELIX}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json', ...options.headers } });
  return parseResponse(response, 'Twitch API request');
}

export async function getIdentity({ token, clientId }) {
  const result = await helix('/users', token, clientId);
  const user = result.data?.[0];
  if (!user?.id || !user?.login || !user?.display_name) throw new Error('Twitch did not return a usable account identity.');
  return { id: String(user.id), login: String(user.login), name: String(user.display_name) };
}

export async function subscribeChat({ token, clientId, broadcasterId, sessionId }) {
  const result = await helix('/eventsub/subscriptions', token, clientId, { method: 'POST', body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId }, transport: { method: 'websocket', session_id: sessionId } }) });
  const sub = result.data?.[0];
  if (!sub || sub.type !== 'channel.chat.message' || sub.status !== 'enabled' || sub.condition?.broadcaster_user_id !== broadcasterId || sub.condition?.user_id !== broadcasterId) throw new Error('Twitch did not confirm the expected enabled channel.chat.message subscription.');
  return { id: sub.id, status: sub.status };
}

export async function revokeToken({ token, clientId }) {
  const response = await fetch(`${OAUTH}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, token }) });
  if (!response.ok) throw new Error(`Twitch token revocation failed (${response.status}).`);
}

export class EventSubClient {
  constructor({ tenantId, getToken, clientId, onEvent, onStatus }) {
    this.tenantId = tenantId; this.getToken = getToken; this.clientId = clientId; this.onEvent = onEvent; this.onStatus = onStatus;
    this.socket = null; this.oldSocket = null; this.closed = false; this.backoff = 1000; this.timer = null; this.keepaliveTimer = null; this.welcomeTimer = null; this.keepaliveSeconds = 10; this.connecting = false;
  }
  start() { this.closed = false; this.connect(); }
  async connect(url = 'wss://eventsub.wss.twitch.tv/ws', handoff = null) {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.onStatus('connecting', 'Connecting to Twitch EventSub.');
    let socket;
    try { socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024, handshakeTimeout: 10_000 }); }
    catch { this.connecting = false; return this.retry(); }
    this.socket = socket; this.oldSocket = handoff;
    let welcomed = false;
    this.welcomeTimer = setTimeout(() => { if (!welcomed) socket.close(); }, 15_000);
    socket.on('error', () => {});
    socket.on('message', async (data) => {
      if (data.length > 64 * 1024) { socket.close(); return; }
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { this.onStatus('error', 'Twitch sent an unreadable EventSub message.'); socket.close(); return; }
      const type = message?.metadata?.message_type;
      if (type === 'session_welcome') {
        const sessionId = message.payload?.session?.id;
        if (!sessionId || welcomed) { socket.close(); return; }
        welcomed = true; clearTimeout(this.welcomeTimer); this.connecting = false; this.backoff = 1000;
        this.keepaliveSeconds = Number(message.payload?.session?.keepalive_timeout_seconds) || 10;
        if (handoff) {
          this.oldSocket = null; handoff.close(1000, 'EventSub reconnect handoff complete');
          this.onStatus('connected', 'Twitch reconnect handoff complete.');
        } else {
          try {
            let token = await this.getToken();
            let sub;
            try { sub = await subscribeChat({ token, clientId: this.clientId, broadcasterId: this.tenantId, sessionId }); }
            catch (error) {
              if (error.status !== 401) throw error;
              token = await this.getToken(true);
              sub = await subscribeChat({ token, clientId: this.clientId, broadcasterId: this.tenantId, sessionId });
            }
            this.onStatus('connected', `Connected to Twitch chat; subscription ${sub.status}.`);
          } catch (error) {
            const denied = error.status === 401 || error.status === 403;
            this.onStatus(denied ? 'permission_denied' : 'error', error.message);
            if (denied) this.closed = true;
            socket.close(); return;
          }
        }
        this.armKeepalive(this.keepaliveSeconds);
      } else if (type === 'session_keepalive') this.armKeepalive(this.keepaliveSeconds);
      else if (type === 'session_reconnect') {
        const next = message.payload?.session?.reconnect_url;
        if (!next || !next.startsWith('wss://eventsub.wss.twitch.tv/')) { socket.close(); return; }
        this.onStatus('reconnecting', 'Twitch requested a WebSocket handoff.');
        this.connect(next, socket);
      } else if (type === 'revocation') {
        this.onStatus('revoked', `Twitch revoked the chat subscription (${String(message.payload?.subscription?.status || 'unknown')}).`);
        this.closed = true; socket.close();
      } else if (type === 'notification') {
        this.armKeepalive(this.keepaliveSeconds);
        const sub = message.payload?.subscription;
        const event = message.payload?.event;
        if (sub?.type !== 'channel.chat.message' || sub?.condition?.broadcaster_user_id !== this.tenantId || !event || event.broadcaster_user_id !== this.tenantId) return;
        const id = message.metadata?.message_id;
        if (typeof id === 'string' && id.length <= 100) this.onEvent(id, event, message.metadata?.message_timestamp);
      }
    });
    socket.on('close', () => {
      if (socket !== this.socket || this.closed) return;
      this.connecting = false; clearTimeout(this.keepaliveTimer); clearTimeout(this.welcomeTimer);
      if (this.oldSocket?.readyState === WebSocket.OPEN) {
        const previous = this.oldSocket; this.oldSocket = null; this.socket = previous;
        this.onStatus('reconnecting', 'Twitch handoff did not complete; retaining the current chat session while retrying.');
        this.retry(); return;
      }
      if (this.oldSocket) { this.oldSocket.close(); this.oldSocket = null; }
      this.onStatus('disconnected', 'Twitch EventSub disconnected. Some chat messages may be missed.');
      this.retry();
    });
  }
  armKeepalive(seconds) {
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => { this.onStatus('reconnecting', 'Twitch keepalive timed out; reconnecting.'); this.socket?.close(); }, (seconds + 5) * 1000);
  }
  retry() {
    if (this.closed || this.timer) return;
    const delay = Math.min(30_000, this.backoff) + Math.floor(Math.random() * 300);
    this.backoff = Math.min(30_000, this.backoff * 2);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
  }
  close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.keepaliveTimer); clearTimeout(this.welcomeTimer); this.socket?.close(1000, 'Channel disconnected'); this.oldSocket?.close(1000, 'Channel disconnected'); }
}
