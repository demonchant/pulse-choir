const CHANNEL_RE = /^[A-Za-z0-9_]{1,25}$/;

export function normalizeChannelLogin(input) {
  if (typeof input !== 'string') return null;
  const login = input.trim().replace(/^@/, '');
  return CHANNEL_RE.test(login) ? login.toLowerCase() : null;
}

export function publicState(tenant, runtime, now = Date.now()) {
  if (!tenant?.owner?.id || !tenant.settings || !runtime) return null;
  const events = (runtime.events || []).slice(-32).map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    degree: event.degree,
    label: event.label,
    beatAt: event.beatAt,
    receivedAt: event.receivedAt,
    beatInBar: Number.isInteger(event.beatInBar) && event.beatInBar >= 1 && event.beatInBar <= 4 ? event.beatInBar : null,
  }));
  return {
    channel: { login: tenant.owner.login, name: tenant.owner.name },
    settings: { tempo: tenant.settings.tempo, key: tenant.settings.key, scale: tenant.settings.scale },
    running: Boolean(tenant.running), muted: Boolean(tenant.muted), sequence: tenant.sequence,
    connection: { state: runtime.state }, events, serverNow: now,
  };
}
