const $ = (selector) => document.querySelector(selector);
const landing = $('#landing');
const dashboard = $('#dashboard');
const landingStatus = $('#landing-status');
let latestState = null;
let pollTimer = null;

function feedback(node, message, error = false) {
  node.textContent = message;
  node.dataset.kind = error ? 'error' : 'success';
}
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Pulse Choir request failed (${response.status}).`);
  return result;
}
function renderConnection(connection) {
  const state = connection?.state || 'disconnected';
  const label = state.replaceAll('_', ' ').toUpperCase();
  $('#session-state').textContent = label;
  $('#session-state').dataset.state = state;
  $('#connection-dot').style.background = state === 'connected' ? 'var(--lime)' : ['error', 'permission_denied', 'revoked'].includes(state) ? 'var(--orange)' : '#837b84';
  $('#connection-detail').textContent = connection?.detail || 'Twitch connection status is unavailable.';
}
function renderEvents(events = []) {
  const lane = $('#note-lane');
  lane.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('div'); empty.className = 'empty-note';
    const glyph = document.createElement('span'); glyph.textContent = '∿'; glyph.setAttribute('aria-hidden', 'true');
    const p = document.createElement('p'); p.textContent = 'No notes yet';
    const small = document.createElement('small'); small.textContent = 'When a viewer plays, it will appear here.';
    empty.append(glyph, p, small); lane.append(empty); return;
  }
  for (const event of events.slice(-12)) {
    const chip = document.createElement('span'); chip.className = 'note-chip';
    chip.textContent = event.label;
    chip.title = event.kind === 'note' ? `Degree ${event.degree} · beat ${event.sequence}` : `Rhythm · beat ${event.sequence}`;
    lane.append(chip);
  }
}
function renderState(state) {
  if (!state) return;
  latestState = state;
  renderConnection(state.connection);
  $('#channel-name').textContent = `@${state.channel?.login || 'channel'}`;
  $('#accepted-count').textContent = String(state.sequence || 0);
  $('#sound-state').textContent = state.muted ? 'Muted' : 'Ready in OBS';
  $('#toggle-running').textContent = state.running ? 'Pause choir' : 'Start choir';
  $('#toggle-mute').textContent = state.muted ? 'Unmute sound' : 'Mute sound';
  const form = $('#settings-form');
  for (const name of ['tempo', 'key', 'scale', 'octave', 'volume', 'audience']) if (document.activeElement !== form.elements[name]) form.elements[name].value = state.settings[name];
  $('#volume-value').textContent = `${state.settings.volume}%`;
  renderEvents(state.events);
}
async function loadState() {
  const me = await request('/api/me');
  if (!me.connected) {
    dashboard.hidden = true; landing.hidden = false;
    const error = new URLSearchParams(location.search).get('auth_error');
    if (error === 'denied') landingStatus.textContent = 'Twitch authorization was denied. No channel was connected.';
    if (error === 'failed') landingStatus.textContent = 'Twitch connection failed. Check your authorization and try again.';
    if (me.reauthorizationRequired) landingStatus.textContent = 'Twitch authorization expired or was revoked. Connect your channel again to resume.';
    return false;
  }
  landing.hidden = true; dashboard.hidden = false; renderState(me.state);
  const sourceButton = $('#create-overlay');
  sourceButton.textContent = me.overlayReady ? 'Rotate private source link ↗' : 'Create private source link ↗';
  const companionUrl = new URL('/companion', location.origin);
  companionUrl.searchParams.set('channel', me.owner.login);
  $('#companion-url').value = companionUrl.toString();
  return true;
}
async function poll() {
  try { const state = await request('/api/state'); renderState(state); }
  catch (error) { renderConnection({ state: 'permission_denied', detail: error.message }); feedback($('#control-feedback'), error.message, true); }
}
function beginPolling() { clearInterval(pollTimer); pollTimer = setInterval(poll, 2000); }

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true; feedback($('#settings-feedback'), 'Saving settings…');
  const form = new FormData(event.currentTarget);
  const body = { tempo: Number(form.get('tempo')), key: String(form.get('key')), scale: String(form.get('scale')), octave: Number(form.get('octave')), volume: Number(form.get('volume')), audience: String(form.get('audience')) };
  try { const state = await request('/api/settings', 'POST', body); renderState(state); feedback($('#settings-feedback'), 'Sound settings saved.'); }
  catch (error) { feedback($('#settings-feedback'), error.message, true); }
  finally { button.disabled = false; }
});
$('#settings-form [name=volume]').addEventListener('input', (event) => { $('#volume-value').textContent = `${event.target.value}%`; });

async function runControl(path, label) {
  const status = $('#control-feedback'); feedback(status, `${label}…`);
  for (const button of document.querySelectorAll('.transport-controls button')) button.disabled = true;
  try { const state = await request(path, 'POST', {}); renderState(state); feedback(status, `${label} complete.`); }
  catch (error) { feedback(status, error.message, true); }
  finally { for (const button of document.querySelectorAll('.transport-controls button')) button.disabled = false; }
}
$('#toggle-running').addEventListener('click', () => runControl(latestState?.running ? '/api/pause' : '/api/start', latestState?.running ? 'Pausing choir' : 'Starting choir'));
$('#toggle-mute').addEventListener('click', () => runControl('/api/mute', latestState?.muted ? 'Unmuting sound' : 'Muting sound'));
$('#clear-notes').addEventListener('click', () => runControl('/api/clear', 'Clearing notes'));

$('#create-overlay').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true; feedback($('#overlay-feedback'), 'Creating a new private source link…');
  $('#overlay-result').hidden = true;
  try {
    const result = await request('/api/overlay-key', 'POST', {});
    $('#overlay-url').value = result.url; $('#overlay-result').hidden = false;
    button.textContent = 'Rotate private source link ↗';
    feedback($('#overlay-feedback'), 'New key created. Any previous source link is now revoked.');
    $('#overlay-url').focus();
  } catch (error) { feedback($('#overlay-feedback'), error.message, true); }
  finally { button.disabled = false; }
});
$('#copy-overlay').addEventListener('click', async () => {
  const input = $('#overlay-url');
  try { await navigator.clipboard.writeText(input.value); feedback($('#overlay-feedback'), 'Private OBS URL copied to clipboard.'); }
  catch { input.select(); feedback($('#overlay-feedback'), 'Clipboard access failed. The URL is selected so you can copy it manually.', true); }
});
$('#copy-companion').addEventListener('click', async () => {
  const input = $('#companion-url');
  try { await navigator.clipboard.writeText(input.value); feedback($('#companion-feedback'), 'Accessible companion link copied.'); }
  catch { input.select(); feedback($('#companion-feedback'), 'Clipboard access failed. The link is selected so you can copy it manually.', true); }
});
$('#disconnect').addEventListener('click', async () => {
  if (!window.confirm('Disconnect this Twitch channel and revoke Pulse Choir access? The current private OBS link will stop working.')) return;
  const button = $('#disconnect'); button.disabled = true; feedback($('#control-feedback'), 'Disconnecting and revoking Twitch access…');
  try { await request('/api/disconnect', 'POST', {}); clearInterval(pollTimer); location.assign('/'); }
  catch (error) { feedback($('#control-feedback'), error.message, true); button.disabled = false; }
});

loadState().then((connected) => { if (connected) beginPolling(); }).catch((error) => {
  landingStatus.textContent = error.message;
  landingStatus.dataset.kind = 'error';
});
