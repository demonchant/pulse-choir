# Pulse Choir

Pulse Choir turns a Twitch channel’s live chat into a shared, beat-aligned instrument. A streamer connects Twitch, picks a tempo/key/scale and participation limit, then adds a private browser source to OBS. Viewers type `!pulse 1` through `!pulse 7` to contribute a scale degree, or `!pulse clap` for a short rhythm tone. Pulse Choir validates real EventSub chat, applies per-viewer and global limits, schedules accepted notes on the next shared beat, and renders original Web Audio tones in the overlay. A separate public companion provides a text rhythm display and paced screen-reader announcements without playing audio.

**No AI in the product.** Pulse Choir uses deterministic rules and Web Audio synthesis. OpenAI Codex was used as the required development tool for research, implementation, and engineering review; it is not a runtime dependency. There are no model APIs, model keys, or model costs.

**Codex build session ID:** `01a16f4e-9f7c-79f2-87d9-6cbb0c5ef989`

## Current verification status

The implementation and offline verification are present. The official Twitch EventSub WebSocket endpoint returned a real `session_welcome` in a narrow Node.js 24 probe. That probe did not authorize a subscription or receive a chat event. The local Playwright suite passed 10 checks against the real local backend in Edge, using only disconnected/error states. Real Twitch OAuth/chat-to-overlay behavior, OBS audio, public hosting, Docker build/boot, the containerized browser gate, and screen-reader testing are not verified. The service requires real Twitch app credentials and a broadcaster's consent; it fails closed when config is absent. No mock chat or fake connected state is used.

No public deployment URL or recorded demo is available yet.

## Run locally

Requirements: Node.js 24.x; a Twitch Developer application; a broadcaster Twitch account for live use; OBS for audio verification.

1. Register `https://<your-origin>/auth/twitch/callback` as the Twitch OAuth redirect URI. Request only `user:read:chat`.
2. Create `.env.pulse-choir` with the variables below. The app intentionally does not read a generic `.env`.
3. Install and preflight:

   ```powershell
   npm ci
   npm run preflight
   npm run check
   npm test
   npm start
   ```

4. Visit the configured `APP_ORIGIN`, choose **Connect your channel**, and authorize `user:read:chat`. Add a Browser Source using the private URL from the dashboard. In OBS, use the source's **Interact** button and enable sound. Browser audio may require that one-time user gesture; the overlay reports whether audio is enabled.
5. Send a real Twitch chat command such as `!pulse 1`. A note appears and its generated tone is scheduled on the shared beat. Pause, mute, clear, and settings affect the real channel state.

Without valid app credentials or broadcaster authorization, the app does not pretend that the Twitch integration is connected. Viewers use normal Twitch chat and do not create a Pulse Choir account or install an extension. The streamer dashboard provides a separate `/companion?channel=<login>` link to share with viewers. That public companion shows accepted note labels, musical settings, connection state and beat position; it intentionally omits viewer names, raw chat text and Twitch event IDs. It does not play audio.

## Accessibility scope

The OBS visualizer uses note and state labels plus a four-beat position marker; it does not depend on color alone and has no flashing effects. Deaf and hard-of-hearing viewers can follow those visible labels in the stream. Blind and low-vision viewers can use the separate text companion with semantic headings, labeled controls, keyboard focus, adjustable text size, high contrast, reduced motion, and user-configurable polite announcements. Nonspeaking viewers can participate through text chat. The OBS graphic inside Twitch video is not screen-reader accessible to viewers, and Pulse Choir does not claim to make the rest of a stream accessible. These are design and implementation claims only; no screen-reader/browser combination or disabled-user validation was completed in this build.

### Configuration

| Variable | Required | Purpose and format |
|---|---|---|
| `TWITCH_CLIENT_ID` | Yes | Twitch Developer application client ID. |
| `TWITCH_CLIENT_SECRET` | Yes | Twitch app secret; server only. |
| `TWITCH_REDIRECT_URI` | Yes | Exact absolute callback `${APP_ORIGIN}/auth/twitch/callback`; register it in Twitch. |
| `APP_ORIGIN` | Yes | Canonical origin, no path or trailing slash; HTTPS in production, loopback HTTP allowed locally. |
| `SESSION_SECRET` | Yes | Exactly 32 random bytes, base64url; signs dashboard cookies. |
| `TOKEN_ENCRYPTION_KEY` | Yes | Separate 32 random bytes, base64url; encrypts saved Twitch tokens. |
| `DATA_DIR` | Production | Persistent writable path; defaults to `./data` locally. |
| `PORT` | Optional | Listen port 1–65535; hosting providers usually set it. |
| `NODE_ENV` | Optional | `development` or `production`; production requires HTTPS and `DATA_DIR`. |

Generate each secret independently with Node: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Never commit `.env.pulse-choir`. Setting variables does not register a Twitch app, grant consent, provision storage, or deploy the service. The ignored local `.env.example` is retained for development; this submission intentionally excludes it, so this table is the public configuration reference.

## Commands and limits

- `!pulse 1` … `!pulse 7`: play one of seven scale degrees.
- `!pulse clap`: add a short synthesized rhythm tap.
- One accepted contribution per viewer every 1.8 seconds; a per-channel token bucket limits bursts. Queue size and message shape are bounded. Excess events are dropped and surfaced to the streamer.
- Configurable tempo: 60–180 BPM; supported keys: C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B; scales: major, minor, pentatonic; octave: 2–5; sound level: 0–100; audience: everyone/subscribers/moderators.

## Security and operations

OAuth tokens are stored only on the server, encrypted at rest with `TOKEN_ENCRYPTION_KEY`. Dashboard sessions use signed HttpOnly cookies. OAuth state is short-lived, one-use, and browser-bound. Twitch authorization uses the minimum documented read-chat scope. Overlay URL keys are random, revocable, stored as hashes, exchanged from the URL fragment for a one-use short-lived WebSocket ticket, and can only read a single tenant's sanitized state. Overlay controls are read-only. Channel settings and Twitch connections are tenant-isolated by Twitch user ID.

The initial deployment design is one active Node process with a persistent data directory; do not run multiple instances against the local JSON store. Code restores settings and encrypted tokens, validates/refreshes authorization, and creates a fresh EventSub session; store restart/isolation behavior is covered by offline tests. A live Twitch restart/reconnect remains unverified. Twitch does not replay missed chat events after a disconnect. Accepted note history is in memory and is not presented as a durable archive.

## Public deployment and evidence

Public deployment requires a provider account, persistent writable storage, TLS/WebSocket support, Twitch app configuration, and server secrets. Current provider choice/cost checks and security setup must be completed before deploying. See official [Twitch Chat](https://dev.twitch.tv/docs/chat/), [OAuth](https://dev.twitch.tv/docs/chat/authenticating), [EventSub](https://dev.twitch.tv/docs/eventsub/), and [EventSub WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/) documentation.

The local research, evidence index, build log, and hackathon planning records are intentionally excluded from the public submission repository per the build instructions. The actual demo must show a real Twitch message in OBS and include Codex build footage, be public on YouTube, and remain under three minutes. The Devpost entry and external repository push are not authorized or completed in this build thread. Current verified offline results and all live-integration limitations are recorded in the local evidence index before any public repository is prepared.
