const $ = (selector) => document.querySelector(selector);
const statusNode = $('.overlay-pill');
let context = null;
let masterGain = null;
let settings = null;
let serverOffsetMs = 0;
let socket = null;
let noteCount = 0;
let retryDelay = 1000;
let manuallyMuted = false;
let channelConnected = false;
const scheduledSources = new Set();
function cancelScheduledNotes() {
  const now = context?.currentTime || 0;
  for (const source of scheduledSources) { try { source.stop(now); } catch {} }
}

function status(state, detail) {
  statusNode.dataset.state = state;
  $('#overlay-status').textContent = state.replaceAll('_', ' ');
  $('#gate-message').textContent = detail;
  $('#overlay-dot').style.background = state === 'connected' ? 'var(--lime)' : ['error', 'permission_denied', 'revoked', 'disconnected'].includes(state) ? 'var(--orange)' : '#9a9099';
}
function showGate(kind, message, help = '') {
  status(kind, message); $('#gate-help').textContent = help;
}
function updateState(state) {
  if (!state) return;
  settings = state.settings; channelConnected = state.connection?.state === 'connected';
  serverOffsetMs = Number(state.serverNow || Date.now()) - Date.now();
  $('#overlay-channel').textContent = `@${state.channel?.login || 'PULSE CHOIR'}`;
  $('#overlay-key').textContent = `${settings.key} ${settings.scale === 'pentatonic' ? 'PENT.' : settings.scale.toUpperCase()}`;
  $('#overlay-tempo').textContent = `${settings.tempo} BPM`;
  $('#overlay-scale').textContent = `${settings.key} ${settings.scale} · octave ${settings.octave}`;
  $('#overlay-count').textContent = `${state.sequence || 0} ${state.sequence === 1 ? 'note' : 'notes'}`;
  const lastEvent = state.events?.at(-1);
  if (lastEvent) updateBeatDisplay(lastEvent);
  $('#beat-ring').classList.toggle('is-paused', !state.running);
  manuallyMuted = !!state.muted;
  if (!state.running || manuallyMuted) cancelScheduledNotes();
  if (masterGain && context?.state === 'running') {
    const now = context.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(state.running && !manuallyMuted ? 1 : 0, now, 0.012);
  }
  $('#overlay-audio-state').textContent = manuallyMuted ? 'Muted by streamer' : context?.state === 'running' ? 'Audio enabled' : 'Audio not enabled';
  $('#enable-audio').hidden = !channelConnected || context?.state === 'running' || manuallyMuted;
  if (!channelConnected) {
    showGate(state.connection?.state || 'disconnected', state.connection?.detail || 'Waiting for Twitch chat connection.', 'The streamer can check the connection in Pulse Choir.');
  } else if (context?.state !== 'running' && !manuallyMuted) {
    showGate('connected', 'Twitch chat is connected. Enable sound in this OBS source.', 'In OBS, right-click this Browser Source → Interact → Enable sound.');
  } else if (manuallyMuted) showGate('connected', 'The streamer has muted the choir.', 'Notes can still appear when the choir is running.');
  else showGate('connected', 'The choir is ready. Play together.', '');
}
function addVisual(event) {
  const lane = $('#visual-notes');
  const chip = document.createElement('span'); chip.className = 'viz-note'; chip.textContent = event.label;
  chip.setAttribute('aria-label', event.kind === 'note' ? `Degree ${event.degree}, ${event.label}` : 'Rhythm tap');
  lane.append(chip); while (lane.children.length > 9) lane.firstElementChild.remove();
  const message = event.kind === 'note' ? `Degree ${event.degree} · ${event.label}` : 'A rhythm tap';
  $('#overlay-note').textContent = message;
  $('#overlay-command').textContent = `Contribution ${event.sequence} · shared composition`;
  updateBeatDisplay(event);
}
function updateBeatDisplay(event) {
  const beat = event.beatInBar;
  if (!Number.isInteger(beat) || beat < 1 || beat > 4) { $('#overlay-beat-summary').textContent = 'A note was accepted; its beat position is unavailable.'; return; }
  for (const cell of $('#beat-sequence').children) {
    const active = Number(cell.dataset.beat) === beat;
    cell.dataset.active = String(active);
    cell.querySelector('small').textContent = active ? 'Last note' : '';
  }
  const note = event.kind === 'clap' ? 'Rhythm tap' : `Degree ${event.degree}, ${event.label}`;
  $('#overlay-beat-summary').textContent = `${note} · beat ${beat} of 4`;
}
function playTone(event) {
  if (!context || context.state !== 'running' || manuallyMuted || !settings || !event.beatAt) return;
  const delay = Math.max(0, (event.beatAt - (Date.now() + serverOffsetMs)) / 1000);
  const at = context.currentTime + delay;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  const peak = Math.max(0.001, settings.volume / 100 * 0.18);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + (event.kind === 'clap' ? 0.085 : 0.34));
  gain.connect(masterGain || context.destination);
  const oscillator = context.createOscillator(); oscillator.type = event.kind === 'clap' ? 'square' : 'sine';
  oscillator.frequency.setValueAtTime(event.kind === 'clap' ? 220 : Math.min(1400, Math.max(55, event.frequency)), at);
  oscillator.connect(gain); oscillator.start(at); oscillator.stop(at + (event.kind === 'clap' ? 0.09 : 0.35));
  scheduledSources.add(oscillator);
  oscillator.onended = () => { scheduledSources.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
}
function eventMessage(event) {
  if (!event || !Number.isInteger(event.sequence) || typeof event.label !== 'string' || !Number.isFinite(event.beatAt)) return;
  addVisual(event);
  if (!manuallyMuted) playTone(event);
  noteCount += 1;
}
function setAudioState(enabled) {
  $('#overlay-audio-state').textContent = enabled ? 'Audio enabled' : 'Audio not enabled';
  $('#enable-audio').hidden = enabled || manuallyMuted;
}
$('#enable-audio').addEventListener('click', async () => {
  const button = $('#enable-audio'); button.disabled = true; button.textContent = 'Enabling sound…';
  try {
    context ||= new AudioContext({ latencyHint: 'interactive' });
    if (!masterGain) { masterGain = context.createGain(); masterGain.gain.value = lastState?.running && !lastState?.muted ? 1 : 0; masterGain.connect(context.destination); }
    await context.resume();
    if (context.state !== 'running') throw new Error('The browser has not enabled audio. Interact with this OBS source again.');
    setAudioState(true); updateState(lastState);
  } catch (error) { showGate('error', error.message, 'Allow audio in OBS Browser Source settings and interact with the source again.'); }
  finally { button.disabled = false; button.innerHTML = 'Enable sound <span aria-hidden="true">♫</span>'; }
});
let lastState = null;
async function connectOverlay() {
  const key = location.hash.slice(1);
  if (!key) return showGate('disconnected', 'This private source link has no key.', 'Generate a new source URL in your streamer dashboard.');
  history.replaceState(null, '', location.pathname);
  showGate('connecting', 'Connecting this private source…');
  let exchange;
  try {
    const response = await fetch('/api/overlay/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    exchange = await response.json();
    if (!response.ok) throw new Error(exchange.error || 'This overlay key was rejected.');
  } catch (error) { return showGate('error', error.message, 'The streamer can generate a fresh, private source URL.'); }
  const ticketProtocol = `pulse-ticket.${exchange.ticket}`;
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`;
  socket = new WebSocket(url, ['pulse-overlay', ticketProtocol]);
  socket.addEventListener('open', () => { retryDelay = 1000; });
  socket.addEventListener('message', (message) => {
    if (typeof message.data !== 'string' || message.data.length > 64 * 1024) return;
    let payload; try { payload = JSON.parse(message.data); } catch { return; }
    if (payload.type === 'state') { lastState = payload.state; updateState(payload.state); }
    else if (payload.type === 'note') { lastState = payload.state; updateState(payload.state); eventMessage(payload.event); }
    else if (payload.type === 'clear') { lastState = payload.state; cancelScheduledNotes(); updateState(payload.state); $('#visual-notes').replaceChildren(); $('#overlay-note').textContent = 'Waiting for the first note'; $('#overlay-command').textContent = 'Chat can play !pulse 1 through !pulse 7'; $('#overlay-beat-summary').textContent = 'No accepted notes yet.'; for (const cell of $('#beat-sequence').children) { cell.dataset.active = 'false'; cell.querySelector('small').textContent = ''; } }
  });
  socket.addEventListener('error', () => showGate('reconnecting', 'The Pulse Choir connection was interrupted.', 'Reconnecting to the private channel state.'));
  socket.addEventListener('close', (event) => {
    if (event.code === 4001) return showGate('revoked', 'This private source link was revoked.', 'Generate a new private source URL in the streamer dashboard.');
    if (['revoked', 'permission_denied'].includes(statusNode.dataset.state)) return;
    showGate('reconnecting', 'Pulse Choir disconnected. Reconnecting…', 'Recent chat events may be missed during a disconnect.');
    const delay = retryDelay; retryDelay = Math.min(15_000, retryDelay * 2);
    setTimeout(connectOverlay, delay + Math.floor(Math.random() * 250));
  });
}
connectOverlay();
