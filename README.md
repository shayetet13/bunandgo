# LINE Race-to-Answer Bot Console

Hybrid dashboard for a fastest-reply LINE bot: `backend/` (Bun + TypeScript,
vendored from `linejs-main`) owns login/session/E2EE and the realtime push
listener; `backend/sender` (Go) is a protocol-agnostic fallback relay while
the latency-first path sends directly from Bun; `frontend/`
(React + Vite) is the live dashboard with P95 latency tracking.

`linejs-main/` is reference-only — never edited or run directly. The actual
runtime code lives in `backend/src/linejs-core`, copied and adapted for Bun.

## Run

```bash
cd backend
bun install
bun run start
```

This also builds/launches the Go sender automatically (compiles from
`backend/sender` on first run if no binary is present yet — prebuild with
`cd backend/sender && go build -o sender.exe .` on Windows for a faster
start). The API/WS server listens on `http://localhost:8787`.

```bash
cd frontend
bun install
bun run dev
```

Dashboard at `http://localhost:5173`. Log in first (see below). Layout is
a persistent left sidebar (Overview / Bot fleet / Rule builder / Live feed
/ Settings) with a topbar (bot search, notifications, system status,
emergency **STOP** for every running bot) and full page content on the
right:

- **Overview** — live hero, real stat cards (bots online, throughput,
  P95, auto-reply rate), a per-minute dispatch chart, and infra health
  (backend/Go-dispatcher connectivity) — everything shown is real data,
  nothing fabricated
- **Bot fleet** — create/start/stop/delete bots; creating one immediately
  starts a QR login inline in the list. If the QR isn't scanned in time
  it auto-refreshes with a new one (keeps retrying until scanned or you
  hit stop)
- **Rule builder** — pick a bot, manage its race rules, and test-send
  against its chats
- **Live feed** — pick a bot, watch its in/out messages in real time
- **Settings** — admin account info and logout

Add as many bots as needed; each is a fully separate LINE account (own
session/tokens/E2EE keys, own chats, own race rules). The P95/throughput
stats on Overview are global across all bots. UI is in Thai; click the
**?** help button in the topbar for an in-app explanation of every
feature.

## Login

Default admin credentials: **admin** / **Root#77**. Override via
`ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars before running the backend —
strongly recommended for anything beyond local/dev use. Dashboard sessions
persist in SQLite, renew while in use, and are revoked by explicit logout.

## Notes

- `DISPATCH_TOKEN` (shared secret between Bun and Go) is auto-generated per
  run if not set in the environment.
- The default hybrid transport keeps login/control RPCs on Go and sends
  latency-sensitive Talk/Square replies plus enabled-room Square event polls
  directly over owned HTTP/2 lanes from Bun. The normal Square push remains
  connected in parallel; message-id dedupe lets the first receive path win.
  Set
  `LINE_TRANSPORT=go` to route everything through Go, or `LINE_TRANSPORT=direct`
  to force Bun for diagnostics. Go uses compact binary frames; set
  `DISPATCH_BINARY=0` only to roll back to legacy JSON/Base64 frames.
- Account protection is drop-based: while `SEND_MIN_INTERVAL_MS` is active,
  or after `SEND_MAX_PER_WINDOW` sends inside `SEND_WINDOW_MS`, a matching
  message is discarded immediately and is never queued for a stale reply.
- Protocol debug logging is disabled on the reply hot path by default. Set
  `LINEJS_DEBUG_LOGS=1` temporarily when diagnosing the LINE transport.
- Enabled OpenChats use exactly one dedicated poll cursor per LINE session;
  requested worker/room counts are capped at one. Zero-delay workers require
  `SQUARE_FAST_POLL_ALLOW_ZERO_MS=1`, reserved send lanes, and an explicit
  `SQUARE_FAST_POLL_SLOTS` budget no larger than the remaining poll lanes.
  Polls never overlap. Established bots retain their fast slots when sibling
  or other users' bots come online; only a bot beyond worker capacity uses the
  100ms overflow path instead of downgrading every bot in the process.
- Data (bots, session tokens, rules, chats, latency history) lives in
  `backend/data/app.db` (SQLite), keyed by `bot_id` for full isolation
  between accounts.
