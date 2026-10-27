# Pulse Choir

- **Project repository:** https://github.com/demonchant/pulse-choir
- **Live demo:** https://pulse-choir.onrender.com
- **Public demonstration video (2:50):** https://youtu.be/wNyNm7cIf1s

## The problem

Live streams often ask viewers to listen, watch an overlay, or speak to take part. That can make a shared musical moment harder to follow or join for Deaf and hard-of-hearing viewers, blind and low-vision viewers, and viewers who do not speak aloud.

## The solution

Pulse Choir gives a Twitch community a text-based way to make music together. The streamer sets the tempo, key, scale, octave, volume, and participation rule, then adds a private Pulse Choir Browser Source to OBS. Viewers send `!pulse 1` through `!pulse 7` for notes or `!pulse clap` for a rhythm tap. Accepted commands are mapped to the selected scale and scheduled on the shared beat. The visualizer shows the notes and synthesizes original tones in the browser.

The separate text companion presents channel state, musical settings, beat position, and recent accepted notes. It offers configurable screen-reader announcement pace and detail, pause/resume announcements, text sizing, high contrast, and reduced motion. Viewers can use the participation option that works best for them; these features are intended to make the shared activity more inclusive, while individual access needs can differ.

## How we built it with Codex

OpenAI Codex supported research, implementation, code review, and documentation. It helped build the Twitch connection and chat handling, streamer dashboard, OBS visualizer, and text companion. Pulse Choir uses deterministic music rules and Web Audio synthesis; it has no runtime AI or model API.

**Codex session ID:** `01a16f4e-9f7c-79f2-87d9-6cbb0c5ef989`

## Hackathon submission details

- The public video is under three minutes and shows Pulse Choir working with Twitch, a Codex build clip, and the main product features.
- The project is built with Codex; the session ID and explanation of Codex's role are above.
- The video uses Pulse Choir's original synthesized tones and contains no added copyrighted music or stock footage.
- The source repository includes the application, assets, and the run instructions below. The public demo is provided for review; keep it available free of charge and without access restrictions through the judging period.
- Confirm the entrant is eligible, the submission is original work with rights to its included materials, and no disallowed sponsor support applies. Complete individual/team status and team representative details on the hackathon form. If the repository becomes private, share it with `testing@devpost.com` as required.

The companion and visualizer provide different ways to follow and join the music. These are accessibility-focused design and implementation features; formal testing with disabled users has not been completed.

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

## Streamer-to-viewer workflow

1. The streamer opens Pulse Choir and connects the Twitch broadcaster account through Twitch OAuth.
2. In the dashboard overview, the streamer checks the actual Twitch chat connection, choir running/paused state, accepted contribution count, current room settings, audience rule, and whether a private OBS source link has been created.
3. The streamer creates the private source URL, adds it to OBS as a Browser Source, and enables browser audio once through OBS **Interact**. The dashboard reports that the private link exists; it cannot detect whether OBS is open or the source is currently visible.
4. The streamer copies and shares the public accessible companion URL with viewers who want the text-based note and beat display.
5. A viewer joins the Twitch channel and types `!pulse 1` through `!pulse 7`, or `!pulse clap`, in Twitch chat. They do not need a Pulse Choir account, extension, microphone, or AI service. The server validates the real chat event and participation rule; accepted notes appear in the dashboard, OBS visualizer, and companion.
6. The streamer can pause/resume the choir, mute/unmute overlay sound, change settings, or clear the visible recent composition from the dashboard.

The dashboard overview is a live summary of backend state. It does not claim that OBS audio is playing or that viewers can hear it; confirm that in OBS during setup.

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

The initial deployment design is one active Node process with a persistent data directory; do not run multiple instances against the local JSON store. Code restores settings and encrypted tokens, validates/refreshes authorization, and creates a fresh EventSub session; store restart/isolation behavior is covered by offline tests. After a disconnect, Twitch does not replay missed chat messages. The service starts a fresh EventSub session, and accepted note history is held in memory rather than presented as a durable archive.

## Public deployment and evidence

The public demo is linked at the top of this README. A self-hosted deployment requires persistent writable storage, TLS/WebSocket support, a Twitch app configuration, and server secrets. See official [Twitch Chat](https://dev.twitch.tv/docs/chat/), [OAuth](https://dev.twitch.tv/docs/chat/authenticating), [EventSub](https://dev.twitch.tv/docs/eventsub/), and [EventSub WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/) documentation.

The public submission links above are provided for judging. Complete the entrant eligibility and individual/team representative fields on the hackathon form.
