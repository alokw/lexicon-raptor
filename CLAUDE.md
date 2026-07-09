# Lexicon Raptor — maintainer notes

Web dashboard for firing cues on **primary + backup Pixera media servers** during live events. Node backend (owns TCP connections to Pixera) + React frontend (Vite). Used live — **reliability beats cleverness; never break a working GO button.**

## Run / build / test

```bash
npm start                  # backend on :8000 (serves web/dist if built)
npm run dev:web            # Vite dev server on :5173, proxies /api + /ws to :8000
npm run build:web          # build frontend into web/dist
npm run mock               # fake Pixera on :1400 (node tools/mock-pixera.js [port])
docker compose up -d --build
```

Standard test loop: start `mock` on 1400 and 1401, start backend, then either use the UI or curl (see "Smoke test" below). There is no test framework; the mock + curl is the regression suite.

## Architecture

```
Browser(s) ←HTTP/WS→ server/index.js ←TCP pxr1 JSON-RPC→ Pixera primary (:1400)
                          │                └─────────────→ Pixera backup  (:1400)
                          ├─ server/pixera/connection.js  one TCP socket: framing,
                          │                               reconnect+backoff, heartbeat,
                          │                               request/response by JSON-RPC id
                          ├─ server/pixera/manager.js     dual-server orchestration,
                          │                               500ms feedback polling, import
                          ├─ server/show-store.js         data/show.json persistence
                          └─ server/comms-log.js          ring buffer → debug panel
web/src/lib/store.jsx     WS client + useReducer store (all state pushed from server)
web/src/lib/api.js        REST client
web/src/components/       Header, CueGrid, PropertyPanel, ImportModal, DebugModal, Toasts
```

**The backend is the single source of truth.** Browsers send REST actions; the server mutates state, persists, and broadcasts fresh state over WS to *all* clients (multi-client sync is free this way — keep it). No optimistic UI state beyond flash/selection.

### Core design decision: names, not handles

Pixera object **handles differ between primary and backup** and can change across project loads. Therefore:

- **Firing/transport uses name-based `Pixera.Compound.*` calls** — the identical JSON goes to every enabled+connected server (`manager.sendToAll`). A GO succeeds if ≥1 server accepts (`failures` reported per-server).
- **Handles are only used transiently** on one server (the "preferred": primary if connected, else backup) for enumeration: selected-timeline lookup and cue import. Never persist a handle.

## Pixera protocol cheat sheet

Full reference lives in `pixera_api_ref/` (`pixera_api_plain_rev481.txt` = signatures, `_comments_` = docs, `_examples_` = JSON for every call, PDF = transport/monitoring).

- **Transport**: TCP, Pixera API port mode **"JSON/TCP"** (default port 1400; Pixera must be restarted after changing API settings). Frame = `"pxr1"` + uint32 **LE** payload size + UTF-8 JSON-RPC 2.0. Implemented in `connection.js` (send + receive incl. resync); mirrored in `tools/mock-pixera.js`.
- **Requests**: `{"jsonrpc":"2.0","id":N,"method":"Pixera.Namespace.fn","params":{...}}`. Class methods take `"handle":N` in params. Responses matched by `id`; `null`-returning calls have no `result` key.
- **Key calls used**:
  - `Pixera.Compound.applyCueOnTimeline {timelineName, cueName, blendDuration}` — GO. `blendDuration` is **seconds** (UI stores ms; divide by 1000 — see `manager.fireCue`).
  - `Pixera.Compound.setTransportModeOnTimeline {timelineName, mode}` — mode **1=Play 2=Pause 3=Stop**.
  - `Pixera.Compound.startOpacityAnimationOfTimeline {name, fadeIn, fullFadeDuration}` — fade up/down, duration in **seconds**.
  - `Pixera.Compound.getCurrentHMSFOfTimeline {name}` / `getCurrentCountdownHMSFOfTimeline {name}` — elapsed / next-cue countdown strings `hh:mm:ss:ff`.
  - `Pixera.Timelines.getTimelinesSelected` → handles; `Timeline.getName {handle}`.
  - `Pixera.Timelines.getTimelineNames`, `getTimelineFromName {name}`, `Timeline.getCueInfosAsJsonString {handle}` (fast import path, JSON shape **unverified against real hardware** — defensive parse with per-cue fallback in `manager.listCuesForTimeline`).
  - `Pixera.Utility.getApiRevision` — used as heartbeat ping.
- **Cue `operation` enum: 1=Play, 2=Pause, 3=Stop, 4=Jump** (badges in ImportModal).
- Monitoring/subscription API exists (see PDF §6–7: `pollMonitoring`, `setMonitoringEventMode`) — **not used yet**; polling was chosen for simplicity. It's the natural upgrade path if 500ms polling becomes limiting; unsolicited messages already surface via connection's `'unmatched'` event.

## Show file (`data/show.json`)

Human-readable by design (users hand-edit and copy between machines). `{version, settings:{primary:{ip,port,enabled}, backup:{...}, defaultFadeMs}, cues:[{id,label,cueName,timelineName,fadeMs,notes}]}`.

- `timelineName: ""` → fire on Pixera's currently-selected timeline; `fadeMs: null` → use `defaultFadeMs`. Resolution happens at fire time in the `/api/cues/:id/fire` route.
- Writes are **atomic** (tmp+rename). Corrupt files are backed up as `show.json.invalid-<ts>`, never clobbered. All input passes `sanitizeCueInput`/`sanitizeServer`.
- File is read **once at startup** — hand-edits need a server restart (documented; a chokidar-style watcher is a welcome future improvement).

## API surface (server/index.js)

`GET /api/state` · `PUT /api/settings` · `POST /api/cues` · `PUT /api/cues/order {ids}` · `PUT /api/cues/:id` · `DELETE /api/cues/:id` · `POST /api/cues/:id/fire` · `POST /api/transport {action: play|pause|stop|fadeUp|fadeDown}` · `GET /api/import/cues` · `GET /api/log` · `GET /api/health`.

WS `/ws` pushes: `state` (full snapshot on connect + after any mutation), `playback`, `connections`, `log` (single entry), `logHistory` (on connect).

⚠️ **Route order matters**: `/api/cues/order` must stay listed *before* `/api/cues/:id` (the `:id` regex `[\w-]+` matches "order").

## Frontend conventions & gotchas

- **Run mode fires on `pointerdown`, not click** — deliberate, for live-op snappiness (CueGrid `onTilePointerDown`). Edit mode: pointerdown selects, drag >8px starts pointer-based reorder (works on touch; `touch-action: none` in edit mode), commit on pointerup via `PUT /api/cues/order`.
- Zoom (1–6) sets `--tile-min` / `--tile-font` / `--tile-meta-font` from `ZOOM_LEVELS` in CueGrid.jsx; persisted in `localStorage` (client pref, not show data).
- Layout: `.workspace` is the height-constrained box (`overflow:hidden`); cue grid and `.panel-scroll` scroll internally; mode toggle + panel footer stay pinned. Don't reintroduce page-level scrolling — the mode-toggle-scrolled-away bug came from that.
- ImportModal dedup key is `` `${timelineName}||${cueName}` `` matched against existing cues; existing ones are greyed/disabled.
- Errors surface as toasts (`toast(msg)` from store); server errors include per-server detail strings.

## Reliability invariants (don't regress these)

1. Losing either server must never block firing on the other (`sendToAll` uses `allSettled`; only fails if *all* targets fail).
2. Connection self-heals: reconnect backoff 1s→5s; heartbeat every 3s destroys half-open sockets. `configure()` only reconnects when ip/port/enabled actually changed.
3. Every request has a timeout (defaults 5s; control actions 3s; polling 2s). No unbounded awaits.
4. All Pixera traffic goes through `connection.request()` so it lands in the comms log (polling/heartbeat use `quiet: true` to avoid log spam — keep GO/transport loud).
5. Show file writes stay atomic + sanitized.

## Smoke test

```bash
node tools/mock-pixera.js 1400 & node tools/mock-pixera.js 1401 &
npm start &
curl -sX PUT localhost:8000/api/settings -H 'Content-Type: application/json' \
  -d '{"primary":{"ip":"127.0.0.1","port":1400,"enabled":true},"backup":{"ip":"127.0.0.1","port":1401,"enabled":true}}'
curl -s localhost:8000/api/state | python3 -m json.tool   # both "connected", playback populated
curl -s localhost:8000/api/import/cues | python3 -m json.tool
# add + fire a cue, kill one mock and fire again (must still succeed), check /api/log
```

## Known unknowns / roadmap

- `getCueInfosAsJsonString` and `getTimelineInfosAsJsonString` reply shapes are guessed from the API docs, not verified on real hardware. Fast-path parser is defensive; tighten once real samples exist.
- "Remaining time" is currently Pixera's *next-cue countdown* — rev 481 exposes no direct timeline duration. Candidate: parse `getTimelineInfosAsJsonString`.
- Natural next features (architecture already accommodates): per-cue colors (`Cue.getColor` exists), monitoring subscriptions instead of polling, show-file hot reload, multi-page cuelists, keyboard/hotkey GO.
