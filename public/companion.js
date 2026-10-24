const $ = (selector) => document.querySelector(selector);
const form = $('#channel-form');
const input = $('#channel-input');
const view = $('#companion-view');
const feedback = $('#channel-feedback');
const liveRegion = $('#announcements');
let socket = null;
let retryTimer = null;
let retryDelay = 1000;
let activeLogin = '';
let announcementQueue = [];
let announcementTimer = null;
let lastAnnouncementAt = 0;
let announcementPaused = false;
let lastState = null;
let fontSize = 18;
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

function safePreference(key, fallback) {
  try { return localStorage.getItem(`pulse-companion-${key}`) ?? fallback; } catch { return fallback; }
}
function savePreference(key, value) {
  try { localStorage.setItem(`pulse-companion-${key}`, String(value)); } catch {}
}
function validLogin(value) { return /^@?[A-Za-z0-9_]{1,25}$/.test(value.trim()); }
function setConnection(text, state = 'neutral') {
  const node = $('#connection-status'); node.textContent = text; node.dataset.state = state;
}
function renderEvents(events = []) {
  const list = $('#note-list'); list.replaceChildren();
  if (!events.length) {
    const item = document.createElement('li'); item.className = 'empty';
    item.textContent = 'Waiting for real accepted chat commands. No sample activity is shown.'; list.append(item); return;
  }
  for (const event of events.slice(-16).reverse()) {
    const item = document.createElement('li');
    const description = event.kind === 'clap' ? 'Rhythm tap' : `Degree ${event.degree}, ${event.label}`;
    const beat = Number.isInteger(event.beatInBar) ? `Beat ${event.beatInBar} of 4` : 'Beat position unavailable';
    item.textContent = `${description} — ${beat} — contribution ${event.sequence}`;
    list.append(item);
  }
}
function renderState(state) {
  if (!state?.channel || !state.settings) return;
  lastState = state;
  $('#channel-title').textContent = `@${state.channel.login}`;
  $('#tempo-value').textContent = `${state.settings.tempo} beats per minute`;
  $('#scale-value').textContent = `${state.settings.key} ${state.settings.scale}`;
  $('#running-value').textContent = state.running ? 'Running' : 'Paused';
  $('#mute-value').textContent = state.muted ? 'Muted by streamer' : 'Not muted by streamer';
  const connection = state.connection?.state || 'unknown';
  setConnection(connection.replaceAll('_', ' '), connection === 'connected' ? 'connected' : 'neutral');
  $('#note-count').textContent = `${state.sequence || 0} accepted ${(state.sequence || 0) === 1 ? 'note' : 'notes'}`;
  renderEvents(state.events);
  if (state.events?.length) updateRhythm(state.events.at(-1));
}
function scheduleAnnouncement() {
  if (announcementPaused || !announcementQueue.length || announcementTimer) return;
  const interval = Number($('#announcement-rate').value);
  const delay = Math.max(0, interval - (Date.now() - lastAnnouncementAt));
  announcementTimer = setTimeout(flushAnnouncements, delay);
}
function queueAnnouncement(event) {
  announcementQueue.push(event);
  scheduleAnnouncement();
}
function flushAnnouncements() {
  announcementTimer = null;
  if (announcementPaused || !announcementQueue.length) return;
  const batch = announcementQueue.splice(0);
  const latest = batch.at(-1);
  const description = latest.kind === 'clap' ? 'rhythm tap' : `degree ${latest.degree}, ${latest.label}`;
  const beat = Number.isInteger(latest.beatInBar) ? `beat ${latest.beatInBar} of 4` : 'beat position unavailable';
  const prefix = batch.length > 1 ? `${batch.length} new notes. ` : '';
  const detail = $('#announcement-detail').value === 'detailed' && lastState
    ? ` Key ${lastState.settings.key} ${lastState.settings.scale}; ${lastState.settings.tempo} beats per minute.` : '';
  liveRegion.textContent = `${prefix}Latest: ${description}, ${beat}, contribution ${latest.sequence}.${detail}`;
  lastAnnouncementAt = Date.now();
  scheduleAnnouncement();
}
function connect(login) {
  clearTimeout(retryTimer); retryTimer = null;
  socket?.close(); socket = null; activeLogin = login; lastState = null;
  view.hidden = true; feedback.textContent = 'Loading live channel state…'; setConnection('Loading');
  fetch(`/api/public/state?channel=${encodeURIComponent(login)}`, { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not load channel (${response.status}).`);
      if (activeLogin !== login) return;
      feedback.textContent = ''; view.hidden = false; renderState(body); $('#channel-title').focus();
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/companion-live?channel=${encodeURIComponent(login)}`, ['pulse-companion']);
      socket.addEventListener('open', () => { retryDelay = 1000; setConnection('Live updates connected', 'connected'); });
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string' || message.data.length > 64 * 1024) return;
        let payload; try { payload = JSON.parse(message.data); } catch { return; }
        if (payload.type === 'state' || payload.type === 'note' || payload.type === 'clear') renderState(payload.state);
        if (payload.type === 'note' && payload.event) queueAnnouncement(payload.event);
        if (payload.type === 'clear') { $('#rhythm-summary').textContent = 'No recent accepted note is available.'; for (const cell of $('#beat-grid').children) { cell.dataset.active = 'false'; cell.querySelector('small').textContent = ''; } }
        if (payload.type === 'note' && payload.event) updateRhythm(payload.event);
      });
      socket.addEventListener('error', () => setConnection('Connection interrupted; trying to reconnect'));
      socket.addEventListener('close', () => {
        if (activeLogin !== login) return;
        setConnection('Disconnected; reconnecting');
        retryTimer = setTimeout(() => connect(login), retryDelay);
        retryDelay = Math.min(15_000, retryDelay * 2);
      });
    })
    .catch((error) => { if (activeLogin === login) { feedback.textContent = error.message; view.hidden = true; setConnection('Channel unavailable'); input.focus(); } });
}
function updateRhythm(event) {
  const beat = event.beatInBar;
  if (!Number.isInteger(beat) || beat < 1 || beat > 4) { $('#rhythm-summary').textContent = 'A note was accepted; its beat position is unavailable.'; return; }
  for (const cell of $('#beat-grid').children) {
    const active = Number(cell.dataset.beat) === beat;
    cell.dataset.active = String(active);
    cell.querySelector('small').textContent = active ? 'Last note' : '';
  }
  const note = event.kind === 'clap' ? 'Rhythm tap' : `Degree ${event.degree}, ${event.label}`;
  $('#rhythm-summary').textContent = `${note} landed on beat ${beat} of 4.`;
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!validLogin(value)) { feedback.textContent = 'Enter a Twitch channel name using letters, numbers, or underscores.'; input.focus(); return; }
  const login = value.replace(/^@/, '').toLowerCase();
  const url = new URL(location.href); url.searchParams.set('channel', login); history.replaceState(null, '', url);
  connect(login);
});

const rate = $('#announcement-rate'); rate.value = ['30000', '10000', '3000'].includes(safePreference('rate', '10000')) ? safePreference('rate', '10000') : '10000';
rate.addEventListener('change', () => { savePreference('rate', rate.value); clearTimeout(announcementTimer); announcementTimer = null; scheduleAnnouncement(); });
const detail = $('#announcement-detail'); detail.value = ['concise', 'detailed'].includes(safePreference('detail', 'concise')) ? safePreference('detail', 'concise') : 'concise';
detail.addEventListener('change', () => savePreference('detail', detail.value));
$('#toggle-announcements').addEventListener('click', (event) => {
  announcementPaused = !announcementPaused;
  event.currentTarget.setAttribute('aria-pressed', String(announcementPaused));
  event.currentTarget.textContent = announcementPaused ? 'Resume announcements' : 'Pause announcements';
  if (announcementPaused) { clearTimeout(announcementTimer); announcementTimer = null; liveRegion.textContent = 'Announcements paused.'; }
  else { liveRegion.textContent = 'Announcements resumed.'; scheduleAnnouncement(); }
});
$('#text-smaller').addEventListener('click', () => { fontSize = Math.max(16, fontSize - 1); document.documentElement.style.setProperty('--base-size', `${fontSize}px`); savePreference('font-size', fontSize); });
$('#text-larger').addEventListener('click', () => { fontSize = Math.min(26, fontSize + 1); document.documentElement.style.setProperty('--base-size', `${fontSize}px`); savePreference('font-size', fontSize); });
fontSize = Math.min(26, Math.max(16, Number(safePreference('font-size', '18')) || 18));
document.documentElement.style.setProperty('--base-size', `${fontSize}px`);
const contrast = $('#high-contrast'); contrast.checked = safePreference('high-contrast', 'false') === 'true';
contrast.addEventListener('change', () => { document.body.classList.toggle('high-contrast', contrast.checked); savePreference('high-contrast', contrast.checked); });
document.body.classList.toggle('high-contrast', contrast.checked);
const reduced = $('#reduce-motion'); reduced.checked = safePreference('reduce-motion', String(motionQuery.matches)) === 'true';
reduced.addEventListener('change', () => { document.body.classList.toggle('reduce-motion', reduced.checked); savePreference('reduce-motion', reduced.checked); });
document.body.classList.toggle('reduce-motion', reduced.checked);
input.value = new URLSearchParams(location.search).get('channel') || '';
if (input.value && validLogin(input.value)) connect(input.value.replace(/^@/, '').toLowerCase());
