# Lexicon Raptor 🦖

A lightweight, Docker-deployable web dashboard for controlling **primary + backup Pixera media servers** during live events. Build a cuelist of big, touch-friendly GO buttons that fire cues by name on both machines simultaneously.

## Quick start (Docker)

```bash
docker compose up -d --build
```

Open **http://localhost:8000**. The show file is stored at `./data/show.json`.

### Pixera setup

In Pixera: **Settings → API**, set an access port to mode **JSON/TCP** (default port `1400`), then restart Pixera. Do this on both the primary and backup machines. Enter each machine's IP in the dashboard header and flip its toggle on — the dot turns green when connected.

## Quick start (local dev, no Docker)

```bash
npm install                # server deps
npm --prefix web install   # web deps
npm run mock &             # optional: fake Pixera on :1400 (use IP 127.0.0.1)
npm start &                # backend on :8000
npm run dev:web            # Vite dev server on :5173 (proxies to :8000)
```

For a production-style run without Docker: `npm run build:web && npm start` and open :8000.

## How it works

```
Browser UI  ←HTTP/WS→  Node backend  ←TCP (pxr1-framed JSON-RPC)→  Pixera primary
                            └────────←TCP────────────────────────→  Pixera backup
```

- **The backend holds persistent TCP connections** to both servers with auto-reconnect, heartbeats (dead-socket detection), and per-request timeouts.
- **Control commands fan out to every enabled+connected server.** Cues are fired *by timeline/cue name* (`Pixera.Compound.applyCueOnTimeline`), never by handle — handles differ between primary and backup, names don't. Firing succeeds if at least one server accepts.
- **Feedback (selected timeline, transport, elapsed, next-cue countdown)** is polled from the primary (backup if primary is down) every 500 ms and pushed to all browsers over WebSocket.
- **All traffic is logged** to a ring buffer, visible live in the Debug panel.

## The show file (`data/show.json`)

Human-readable, pretty-printed JSON — edit it in any text editor, keep it in version control, copy it between machines. Writes are atomic (temp file + rename), so a crash can't corrupt it. A corrupt/hand-mangled file is never overwritten silently: it's backed up as `show.json.invalid-<timestamp>` and a fresh show is started.

```json
{
  "version": 1,
  "settings": {
    "primary": { "ip": "192.168.1.10", "port": 1400, "enabled": true },
    "backup":  { "ip": "192.168.1.11", "port": 1400, "enabled": true },
    "defaultFadeMs": 1000
  },
  "cues": [
    {
      "id": "…uuid…",
      "label": "Opening Look",
      "cueName": "Opening Look",
      "timelineName": "Main Show",
      "fadeMs": null,
      "notes": "House to half"
    }
  ]
}
```

- `timelineName: ""` → the cue fires on whatever timeline is currently selected in Pixera.
- `fadeMs: null` → the cue uses the default fade time from the header.

> Note: the backend reads the show file at startup. If you hand-edit it, restart the container (`docker compose restart`) to pick up changes.

## Using the dashboard

| Area | What it does |
|---|---|
| **Header left** | Primary/backup IPs, enable toggles, connection dots (green/red, amber = connecting), default fade time (ms). |
| **Header right** | Selected-timeline feedback with transport state, elapsed time, next-cue countdown, and Play / Pause / Stop / Fade ↑ / Fade ↓. |
| **Cuelist (left)** | Big 16:9 GO buttons. **Run mode:** press to fire. **Edit mode:** click to select, drag to reorder, × to delete. |
| **Property panel (right)** | Run/Edit mode toggle, add-cue form, selected-cue properties (read-only in Run mode), Import, and cue-size zoom. |
| **Import** | Pulls every cue from every timeline on the connected server; cues already in the cuelist are greyed out. |
| **Debug** | Live log of every command sent/received per server, with tabs and pause. |

### Debug / API exploration endpoints

Two extra endpoints help inspect the Pixera API from a browser or curl (their traffic also appears in the Debug panel):

```bash
# Timeline info (defaults to the selected timeline; handle resolved for you)
http://localhost:8000/api/debug/timeline-info
http://localhost:8000/api/debug/timeline-info?timeline=Main%20Show

# Arbitrary Pixera.* call on the preferred (or named) server
curl -X POST localhost:8000/api/debug/rpc -H 'Content-Type: application/json' \
  -d '{"method":"Pixera.Utility.getApiRevision"}'          # add "server":"backup" to target one
```

Useful for capturing real reply samples before building features on undocumented calls.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP/WebSocket listen port |
| `DATA_DIR` | `./data` | Where `show.json` lives |

## Design notes / roadmap hooks

- **Name-based firing** was chosen deliberately: it survives project reloads and works identically across primary/backup. Handles are only used transiently (import enumeration, selected-timeline lookup) and never persisted.
- The server modules are independent (`connection` → framing/reconnect, `manager` → orchestration, `show-store` → persistence) so new features (per-cue colors, hotkeys, multi-page cuelists, Pixera monitoring subscriptions) slot in without rework.
- Elapsed time comes from `getCurrentHMSFOfTimeline`; the countdown shown is Pixera's *next-cue countdown*. True "remaining in timeline" is **not possible** on API rev 481 — verified on real hardware that no call (including `getTimelineInfosAsJsonString`) exposes a timeline duration.
- Multiple browsers/tablets can be open at once; state stays in sync via WebSocket.

## Testing without hardware

`npm run mock` starts a fake Pixera (port 1400) with a few timelines and cues that answers all the API calls the dashboard uses. Point the primary IP at `127.0.0.1` (from Docker: `host.docker.internal`).
