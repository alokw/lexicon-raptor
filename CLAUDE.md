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
                          │                               500ms feedback polling, 1s
                          │                               all-timelines polling, import,
                          │                               blend-to-cue
                          ├─ server/show-store.js         data/*.json show library (one
                          │                               active, tracked in config.json)
                          ├─ server/osc.js                minimal UDP OSC listener
                          └─ server/comms-log.js          ring buffer → debug panel
web/src/lib/store.jsx     WS client + useReducer store (all state pushed from server)
web/src/lib/api.js        REST client
web/src/lib/time.js       HMSF ↔ frames helpers (all Pixera times are fps-dependent)
web/src/components/       Header, CueGrid, CueListView, PropertyPanel, ImportModal,
                          SettingsModal, FileMgmtModal, DebugModal, Toasts
```

**The backend is the single source of truth.** Browsers send REST actions; the server mutates state, persists, and broadcasts fresh state over WS to *all* clients (multi-client sync is free this way — keep it). No optimistic UI state beyond flash/selection.

Two top-level views (switcher under the logo, `store.view`, persisted client-side): **Shortcuts** = curated GO-button grid + property panel; **Cue List** = all timelines (right, live status) + every cue of the selected timeline (left, with fade-to-cue ▶/⏸ per row).

### Core design decision: names, not handles

Pixera object **handles differ between primary and backup** and can change across project loads. Therefore:

- **Firing/transport uses name-based `Pixera.Compound.*` calls** — the identical JSON goes to every enabled+connected server (`manager.sendToAll`). A GO succeeds if ≥1 server accepts (`failures` reported per-server).
- **Handles are only used transiently** on one server (the "preferred": primary if connected, else backup) for enumeration: selected-timeline lookup, all-timelines status, and cue import. Never persist a handle.
- The one handle-based *command* is `manager.blendToCue` (Cue List ▶/⏸): `Timeline.blendToTimeWithTransportMode` has no name-based Compound equivalent, so **each server resolves its own handle by name at call time** (same ≥1-must-succeed semantics via `collectFanoutResults`).

## Pixera protocol cheat sheet

Full reference lives in `pixera_api_ref/` (`pixera_api_plain_rev481.txt` = signatures, `_comments_` = docs, `_examples_` = JSON for every call, PDF = transport/monitoring).

- **Transport**: TCP, Pixera API port mode **"JSON/TCP"** (default port 1400; Pixera must be restarted after changing API settings). Frame = `"pxr1"` + uint32 **LE** payload size + UTF-8 JSON-RPC 2.0. Implemented in `connection.js` (send + receive incl. resync); mirrored in `tools/mock-pixera.js`.
- **Requests**: `{"jsonrpc":"2.0","id":N,"method":"Pixera.Namespace.fn","params":{...}}`. Class methods take `"handle":N` in params. Responses matched by `id`; `null`-returning calls have no `result` key.
- **Key calls used**:
  - `Pixera.Compound.applyCueOnTimeline {timelineName, cueName, blendDuration}` — GO. `blendDuration` is **seconds** (UI stores ms; divide by 1000 — see `manager.fireCue`).
  - `Pixera.Compound.setTransportModeOnTimeline {timelineName, mode}` — mode **1=Play 2=Pause 3=Stop**.
  - `Pixera.Compound.startOpacityAnimationOfTimeline {name, fadeIn, fullFadeDuration}` — fade up/down, duration in **frames**, not seconds (ms → frames via `getFpsOfTimeline`; `manager.getTimelineFps` caches fps from polling). Sending seconds makes Pixera snap in ~1 frame *and* overwrite its fade-time field. Rev 481 has no API to read Pixera's own programmed fade time.
  - `Pixera.Compound.getCurrentHMSFOfTimeline {name}` / `getCurrentCountdownHMSFOfTimeline {name}` — elapsed / next-cue countdown strings `hh:mm:ss:ff`.
  - `Pixera.Timelines.getTimelinesSelected` → handles; `Timeline.getName {handle}`.
  - `Pixera.Timelines.getTimelineNames`, `getTimelineFromName {name}`, `Timeline.getCueInfosAsJsonString {handle}` (fast import path; per-cue fallback in `manager.listCuesForTimeline`).
  - `Pixera.Timelines.Timeline.blendToTimeWithTransportMode {handle, goalTime, blendDuration, transportMode}` — fade to a time and land in mode 1 (play) or 2 (pause). `goalTime` and `blendDuration` are **frames** ("Time unit is frames" per docs). Used by Cue List ▶/⏸ with the cue's HMSF time converted via fps (`hmsfToFrames` in manager.js). **VERIFIED on real rev-481 hardware** (2026-07).
  - `Pixera.Utility.getApiRevision` — used as heartbeat ping.
- **`getCueInfosAsJsonString` reply shape — VERIFIED on real rev-481 hardware** (2026-07). `result` is a JSON *string* containing an array of:
  ```json
  {"color":"#8D1D2C","countdown":"00:08:11:57","formattedNumber":"1","handle":6558541823088715,
   "index":13,"jumpgoal":"none","jumpmode":"To Label","name":"Rest in keynote","note":"",
   "number":1,"operation":"Pause","time":"00:08:11:57","waitDuration":0.0}
  ```
  Gotchas vs. the rest of the API: `operation` is a **string** ("Play"/"Pause"/"Stop"/"Jump") here but an **int** (1–4) from `Cue.getOperation`; the field is `formattedNumber` (not "numberFormatted"); `time`/`countdown` are HMSF strings, not frames. `normalizeOperation()` in manager.js accepts both forms → lowercase strings. The mock reproduces this exact shape.
- **Cue `operation` int enum (Cue.getOperation / createCue): 1=Play, 2=Pause, 3=Stop, 4=Jump.**
- **`Timeline.getTimelineInfosAsJsonString` reply shape — VERIFIED on real rev-481 hardware** (2026-07). `result` is a JSON *string*:
  ```json
  {"Mode":"Stop","fps":60.0,"index":0,"name":"10min_countdown",
   "nextcue":{ ...same object shape as one getCueInfosAsJsonString entry... },
   "opacity":1.0,"smptemode":"none","time":"00:00:00:00"}
  ```
  Gotchas: `Mode` has a **capital M** and is a string ("Play"/"Pause"/"Stop"); `time` is current position as HMSF. **There is no duration field** — true "remaining time in timeline" is NOT available from this call (or anywhere else found in rev 481); the next-cue countdown remains the best proxy. Upside: this one call returns transport mode + current time + next-cue info (incl. `nextcue.name` and `nextcue.countdown`) and could replace the three per-poll Compound calls in `manager.pollOnce` with a single handle-based request, and would enable a "Next: <cue name>" display in the header.
- ⚠️ **Real projects contain duplicate cue names** (e.g. "clear" ×8 on one timeline) **and unnamed cues** (`"name":""`). Name-based firing triggers the *first* match; unnamed cues cannot be fired by name at all. ImportModal flags duplicates ("duplicate" tag), disables unnamed cues ("no name" tag), and shows each cue's HMSF time to help distinguish. If exact-cue firing is ever needed, the path is: resolve per-server handle via `Timeline.getCueAtIndex(index)` → verify → `Cue.apply {handle, blendDuration}` — never persist the handle.
- Monitoring/subscription API exists (see PDF §6–7: `pollMonitoring`, `setMonitoringEventMode`) — **not used yet**; polling was chosen for simplicity. It's the natural upgrade path if 500ms polling becomes limiting; unsolicited messages already surface via connection's `'unmatched'` event.

## Show files (`data/*.json`)

Human-readable by design (users hand-edit and copy between machines). The data dir is a **library**: any number of show files, one active at a time (`data/config.json` → `{activeShow}`; defaults to `show.json`). `{version, settings:{primary:{ip,port,enabled}, backup:{...}, defaultFadeMs, shortcuts:{keyboardEnabled, oscEnabled, oscPort}}, cues:[{id,label,cueName,timelineName,fadeMs,notes,color}]}`.

- `timelineName: ""` → fire on Pixera's currently-selected timeline; `fadeMs: null` → use `defaultFadeMs`; `color` is `"#rrggbb"` or `null` (display-only, imported from Pixera or set in the panel). Resolution happens at fire time in the `/api/cues/:id/fire` route.
- Writes are **atomic** (tmp+rename, `atomicWrite`). Corrupt files are backed up as `<name>.json.invalid-<ts>`, never clobbered. All input passes `sanitizeShow`/`sanitizeCueInput`/`sanitizeServer`/`sanitizeShortcuts`; filenames pass `sanitizeShowFilename` (strips path separators — keep that, it's the traversal guard).
- The active file is read at startup and on show switch — hand-edits need a restart or a File Mgmt load-another-and-back (documented; a watcher is a welcome future improvement).
- File Mgmt semantics: create carries over the current connection settings (blank cues); import saves but does **not** activate; the active show can't be deleted; switching a show reapplies settings (connections + OSC) and broadcasts to all clients.

## API surface (server/index.js)

`GET /api/state` · `PUT /api/settings` · `POST /api/cues` · `PUT /api/cues/order {ids}` · `PUT /api/cues/:id` · `DELETE /api/cues/:id` · `POST /api/cues/:id/fire` · `POST /api/transport {action: play|pause|stop|fadeUp|fadeDown, timelineName?}` (no timelineName = Pixera's selected) · `GET /api/import/cues` · `GET /api/timelines/cues?timeline=Name` (ordered cues + fps for the Cue List view) · `POST /api/timelines/blend {timelineName, timeHMSF, transportMode:1|2, fadeMs?}` · `GET /api/log` · `GET /api/health`.

Show library: `GET /api/shows` · `POST /api/shows {name}` (blank) · `POST /api/shows/active {file}` (switch) · `POST /api/shows/import {name, show}` · `GET /api/shows/:file/download` · `DELETE /api/shows/:file`.

Debug/exploration (traffic shows in the Debug panel too): `GET /api/debug/timeline-info?timeline=Name` (defaults to selected timeline; resolves the handle and calls `getTimelineInfosAsJsonString`) · `POST /api/debug/rpc {method:"Pixera.*", params?, server?: "primary"|"backup"}` — use this to capture real reply samples before coding against an unverified call.

WS `/ws` pushes: `state` (full snapshot incl. `activeShow` + `timelines` on connect + after any mutation), `playback`, `connections`, `timelines` (all-timelines status, only-on-change), `log` (single entry), `logHistory` (on connect).

**OSC** (`server/osc.js`, opt-in via `settings.shortcuts`): minimal address-only UDP parser (no deps — show machines are offline). `/raptor/go` = play/pause toggle on the selected timeline; also `/raptor/play|pause|stop`. Rebinding only happens when enabled/port actually changed. Docker needs the UDP port published (compose maps 8100/udp).

`playback.source` names the server feedback is read from: primary while connected, else backup (`manager.preferred()`); shown in the header as a "via primary/backup" tag. Both-enabled → primary; single-enabled → that one; primary lost mid-show → automatic failover to backup.

Polling is consolidated: `pollOnce` → `getTimelinesSelected` + one `getTimelineInfosAsJsonString` call, which yields name/Mode/time/nextcue (`playback.nextCueName`/`nextCueNumber` drive the header's "Next:" readout). If that call fails *structurally* (method missing or shape change — not a timeout), a sticky `_legacyPoll` flag switches to the old three-Compound-calls path (`pollLegacy`) which has no next-cue info. Keep the fallback working when touching polling.

A second poll (`pollTimelinesOnce`, 1s) walks **all** timelines for the Cue List view — one `getTimelineInfosAsJsonString` per timeline, handles cached per server in `_tlHandleCache` (dropped on status change or per-timeline error, so stale handles self-heal after project reloads). It **only runs while ≥1 WS client is connected** (`setTimelinesPolling`, toggled in index.js) — don't make it unconditional; it's per-timeline traffic. fps values observed anywhere land in `_fpsCache` (used for all ms→frames conversions).

⚠️ **Route order matters**: `/api/cues/order` must stay listed *before* `/api/cues/:id` (the `:id` regex `[\w-]+` matches "order").

## Frontend conventions & gotchas

- **Run mode fires on `pointerdown`, not click** — deliberate, for live-op snappiness (CueGrid `onTilePointerDown`). Edit mode: pointerdown selects, drag >8px starts pointer-based reorder (works on touch; `touch-action: none` in edit mode), commit on pointerup via `PUT /api/cues/order`.
- Zoom (1–6) sets `--tile-min` / `--tile-font` / `--tile-meta-font` from `ZOOM_LEVELS` in CueGrid.jsx; persisted in `localStorage` (client pref, not show data).
- Layout: `.workspace` is the height-constrained box (`overflow:hidden`); cue grid and `.panel-scroll` scroll internally; mode toggle + panel footer stay pinned. Don't reintroduce page-level scrolling — the mode-toggle-scrolled-away bug came from that.
- ImportModal dedup key is `` `${timelineName}||${cueName}` `` matched against existing cues; existing ones are greyed/disabled.
- Errors surface as toasts (`toast(msg)` from store); server errors include per-server detail strings.
- **Cue colors are dark-theme-constrained** (user requirement: never bright, text always readable). `web/src/lib/color.js#cueColorStyles(hex)` → `{accent, bg}`: accent = original hue, lightness clamped 0.45–0.65 (tile edge stripe, import swatch, cue-row stripe); bg = same hue, saturation ≤0.45, lightness forced to 0.16 (tile background tint). Near-black (`l < 0.08`, i.e. Pixera's `#000000` default) → `null` = uncolored. Text color is never derived from the cue color — don't change that.
- `CueForm`'s reset effect deps on `JSON.stringify(initial)`, NOT the object — the panel re-renders every playback tick with a fresh `initial` object, and a reference dep would wipe in-progress edits while a timeline plays.
- **Press feedback**: every enabled button scales down on `:active` (global rule in styles.css); GO tiles flash green optimistically on press and **flip to a red `fire-failed` flash if the server rejects the GO** (CueGrid `failedId`) — keep both, operators rely on them.
- **Multi-select** (edit mode): ctrl/cmd-click toggles membership in `store.selectedCueIds`; plain click resets to a single selection. >1 selected → PropertyPanel shows `BulkEditPanel` (per-field opt-in checkboxes so blank ≠ "clear"; both bulk edit and bulk delete are behind `window.confirm` with the count — a user requirement).
- **Keyboard shortcut** (opt-in via settings): Space = play/pause toggle. The window handler in App.jsx skips repeats, `defaultPrevented` events, inputs/buttons/contentEditable, and open modals. Cue tiles' own Space handling (fire/select when focused) still wins — it preventDefaults first.
- Cue List view: current cue = last cue with `frames <= playhead` (client-side, `lib/time.js#hmsfToFrames` with the timeline's fps); ▶ marks current, › marks next. Rows fetch via `GET /api/timelines/cues` on selection/refresh — deliberately not pushed over WS (cue lists are big and change rarely; live status comes from the `timelines` push).

## Reliability invariants (don't regress these)

1. Losing either server must never block firing on the other (`sendToAll`/`blendToCue` use `allSettled` + `collectFanoutResults`; only fail if *all* targets fail).
2. Connection self-heals: reconnect backoff 1s→5s; heartbeat every 3s destroys half-open sockets. `configure()` only reconnects when ip/port/enabled actually changed (ditto `osc.configure`).
3. Every request has a timeout (defaults 5s; control actions 3s; polling 2s). No unbounded awaits.
4. All Pixera traffic goes through `connection.request()` so it lands in the comms log (polling/heartbeat use `quiet: true` to avoid log spam — keep GO/transport/blend loud).
5. Show file writes stay atomic + sanitized; show filenames go through `sanitizeShowFilename` (path traversal guard); the active show can never be deleted.
6. All durations sent to Pixera are converted ms → **frames** via the timeline's fps (`getTimelineFps`) for `startOpacityAnimation*` and `blendToTime*`, but stay **seconds** for `applyCueOnTimeline`'s `blendDuration`. Mixing these up produces 1-frame snaps on real hardware.

## Smoke test

```bash
node tools/mock-pixera.js 1400 & node tools/mock-pixera.js 1401 &
npm start &
curl -sX PUT localhost:8000/api/settings -H 'Content-Type: application/json' \
  -d '{"primary":{"ip":"127.0.0.1","port":1400,"enabled":true},"backup":{"ip":"127.0.0.1","port":1401,"enabled":true}}'
curl -s localhost:8000/api/state | python3 -m json.tool   # both "connected", playback populated
curl -s localhost:8000/api/import/cues | python3 -m json.tool
curl -s "localhost:8000/api/timelines/cues?timeline=Main%20Show" | python3 -m json.tool
curl -sX POST localhost:8000/api/timelines/blend -H 'Content-Type: application/json' \
  -d '{"timelineName":"Main Show","timeHMSF":"00:01:30:00","transportMode":2}'
curl -s localhost:8000/api/shows | python3 -m json.tool
# add + fire a cue, kill one mock and fire again (must still succeed), check /api/log
```

## Known unknowns / roadmap

- Both `getCueInfosAsJsonString` and `getTimelineInfosAsJsonString` shapes are verified on real hardware (see above), as is `blendToTimeWithTransportMode` (2026-07) — every Pixera call the app makes is now hardware-verified. The mock reproduces all of them.
- "Remaining time" is Pixera's *next-cue countdown* — **confirmed** that rev 481 exposes no timeline duration anywhere, so this is as good as it gets (short of summing clip end times via `getClipEndTimeInSecondsWithIndex` per layer, which is expensive).
- Natural next features (architecture already accommodates): monitoring subscriptions instead of polling (would help the 1s all-timelines poll on big projects), show-file hot reload, multi-page cuelists, more OSC addresses (per-cue GO), exact-cue firing by index+verify for duplicate-name timelines.
