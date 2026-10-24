export const SCALES = Object.freeze({ major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], pentatonic: [0, 2, 4, 7, 9] });
export const KEYS = Object.freeze({ C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 });

export function parseCommand(input) {
  if (typeof input !== 'string' || input.length > 100 || !/^!pulse(?:\s|$)/i.test(input)) return null;
  const match = input.trim().match(/^!pulse\s+(1|2|3|4|5|6|7|clap)$/i);
  if (!match) return null;
  return match[1].toLowerCase() === 'clap' ? { kind: 'clap' } : { kind: 'note', degree: Number(match[1]) };
}

export function mapNote(command, settings) {
  if (command.kind === 'clap') return { kind: 'clap', degree: 0, midi: null, frequency: null, label: 'CLAP' };
  const steps = SCALES[settings.scale];
  const index = command.degree - 1;
  const midi = 12 * (settings.octave + 1) + KEYS[settings.key] + steps[index % steps.length] + (index >= steps.length ? 12 : 0);
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  return { kind: 'note', degree: command.degree, midi, frequency: 440 * 2 ** ((midi - 69) / 12), label: `${names[midi % 12]}${Math.floor(midi / 12) - 1}` };
}

export function nextBeat(now, tempo, origin, leadMs = 500) {
  const beatMs = 60_000 / tempo;
  return origin + Math.ceil((now + leadMs - origin) / beatMs) * beatMs;
}

export function acceptChatMessage({ tenant, event, eventId, now, cooldowns, globalLimiter }) {
  if (!event || event.broadcaster_user_id !== tenant.owner.id || typeof event.chatter_user_id !== 'string' || !/^\d{1,30}$/.test(event.chatter_user_id)) return { accepted: false, reason: 'invalid_event' };
  if (typeof event.message?.text !== 'string' || event.message.text.length > 500) return { accepted: false, reason: 'invalid_message' };
  const command = parseCommand(event.message.text);
  if (!command) return { accepted: false, reason: 'not_a_command' };
  if (tenant.settings.audience === 'subs' && !event.badges?.some((badge) => badge.set_id === 'subscriber') && !event.badges?.some((badge) => badge.set_id === 'moderator' || badge.set_id === 'broadcaster')) return { accepted: false, reason: 'audience_restricted' };
  if (tenant.settings.audience === 'mods' && !event.badges?.some((badge) => ['moderator', 'broadcaster'].includes(badge.set_id))) return { accepted: false, reason: 'audience_restricted' };
  const last = cooldowns.get(event.chatter_user_id) || 0;
  if (now - last < 1800) return { accepted: false, reason: 'cooldown' };
  if (!globalLimiter.take(now)) return { accepted: false, reason: 'rate_limited' };
  if (cooldowns.size > 10_000) for (const [id, time] of cooldowns) if (now - time > 60_000) cooldowns.delete(id);
  cooldowns.set(event.chatter_user_id, now);
  const mapped = mapNote(command, tenant.settings);
  const beatAt = nextBeat(now, tenant.settings.tempo, tenant.beatOrigin || now);
  const beatNumber = Math.round((beatAt - (tenant.beatOrigin || now)) / (60_000 / tenant.settings.tempo));
  const acceptedEvent = { id: eventId, sequence: tenant.sequence + 1, beatAt, beatInBar: ((beatNumber - 1 + 4000) % 4) + 1, receivedAt: now, ...mapped };
  return { accepted: true, event: acceptedEvent };
}

export class TokenBucket {
  constructor({ capacity = 30, periodMs = 10_000 } = {}) { this.capacity = capacity; this.periodMs = periodMs; this.tokens = capacity; this.last = 0; }
  take(now) {
    if (!this.last) this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.last) * this.capacity / this.periodMs);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}
