/**
 * Lexicon Raptor server — serves the web UI, exposes the REST API, and pushes
 * live state (connections, playback, comms log) over WebSocket.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { CommsLog } from './comms-log.js';
import { ShowStore } from './show-store.js';
import { OscListener } from './osc.js';
import { PixeraManager } from './pixera/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'web', 'dist');

const log = new CommsLog();
const store = new ShowStore(DATA_DIR);
const pixera = new PixeraManager(log);

pixera.applySettings(store.settings);
pixera.startPolling();

// ---------------------------------------------------------------------------
// OSC remote control (UDP). /raptor/go toggles play/pause like the Space key.
// ---------------------------------------------------------------------------
const OSC_COMMANDS = { '/raptor/go': 'go', '/raptor/play': 'play', '/raptor/pause': 'pause', '/raptor/stop': 'stop' };

const osc = new OscListener(log, async (addr) => {
  const cmd = OSC_COMMANDS[addr];
  if (!cmd) return; // unrecognized addresses are logged by the listener, nothing more
  const action = cmd === 'go' ? (pixera.playback.transportMode === 1 ? 'pause' : 'play') : cmd;
  await pixera.transport(action, pixera.playback.selectedTimelineName);
});
osc.configure(store.settings.shortcuts);

// ---------------------------------------------------------------------------
// WebSocket push
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

pixera.on('playback', (playback) => broadcast({ type: 'playback', playback }));
pixera.on('connections', (connections) => broadcast({ type: 'connections', connections }));
pixera.on('timelines', (timelines) => broadcast({ type: 'timelines', timelines }));
log.on('entry', (entry) => broadcast({ type: 'log', entry }));

function fullState() {
  return {
    type: 'state',
    settings: store.settings,
    cues: store.cues,
    activeShow: store.activeFile,
    connections: pixera.getConnectionStates(),
    playback: pixera.playback,
    timelines: pixera.timelines,
  };
}

function broadcastState() {
  broadcast(fullState());
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(fullState()));
  ws.send(JSON.stringify({ type: 'logHistory', entries: log.recent(500) }));
  // The per-timeline status poll is only worth its traffic while someone is
  // actually watching the dashboard.
  pixera.setTimelinesPolling(true);
  ws.on('close', () => pixera.setTimelinesPolling(wss.clients.size > 0));
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error('request body too large');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/state$/,
    handler: async (req, res) => sendJson(res, 200, fullState()),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings$/,
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      const settings = store.updateSettings(body);
      pixera.applySettings(settings);
      osc.configure(settings.shortcuts);
      broadcastState();
      sendJson(res, 200, { settings });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/cues$/,
    handler: async (req, res) => {
      const cue = store.addCue(await readJsonBody(req));
      broadcastState();
      sendJson(res, 201, { cue });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/cues\/order$/,
    handler: async (req, res) => {
      const { ids } = await readJsonBody(req);
      const cues = store.reorderCues(Array.isArray(ids) ? ids : []);
      broadcastState();
      sendJson(res, 200, { cues });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/cues\/([\w-]+)$/,
    handler: async (req, res, [, id]) => {
      const cue = store.updateCue(id, await readJsonBody(req));
      broadcastState();
      sendJson(res, 200, { cue });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/cues\/([\w-]+)$/,
    handler: async (req, res, [, id]) => {
      store.deleteCue(id);
      broadcastState();
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/cues\/([\w-]+)\/fire$/,
    handler: async (req, res, [, id]) => {
      const cue = store.getCue(id);
      if (!cue) return sendJson(res, 404, { error: 'cue not found' });
      const timelineName = cue.timelineName || pixera.playback.selectedTimelineName;
      if (!timelineName) {
        return sendJson(res, 409, {
          error: 'cue has no timeline and no timeline is selected in Pixera',
        });
      }
      const fadeMs = cue.fadeMs ?? store.settings.defaultFadeMs;
      const result = await pixera.fireCue({ timelineName, cueName: cue.cueName, fadeMs });
      log.add({
        server: 'system',
        dir: 'info',
        data: `fired cue "${cue.label || cue.cueName}" (${timelineName} / ${cue.cueName}, fade ${fadeMs}ms) -> ${result.sentTo.join(', ')}`,
      });
      sendJson(res, 200, { ok: true, ...result, resolved: { timelineName, fadeMs } });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/transport$/,
    handler: async (req, res) => {
      const { action, timelineName: requestedTimeline } = await readJsonBody(req);
      // Cue List view targets specific timelines; the header targets Pixera's
      // currently selected one.
      const timelineName = requestedTimeline || pixera.playback.selectedTimelineName;
      let result;
      if (action === 'fadeUp' || action === 'fadeDown') {
        result = await pixera.fadeOpacity(action === 'fadeUp', timelineName, store.settings.defaultFadeMs);
      } else {
        result = await pixera.transport(action, timelineName);
      }
      sendJson(res, 200, { ok: true, ...result });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/import\/cues$/,
    handler: async (req, res) => {
      const timelines = await pixera.listAllCues();
      sendJson(res, 200, { timelines });
    },
  },
  {
    // Ordered cue list of one timeline, for the Cue List view.
    method: 'GET',
    pattern: /^\/api\/timelines\/cues$/,
    handler: async (req, res, match, url) => {
      const timeline = url.searchParams.get('timeline');
      if (!timeline) return sendJson(res, 400, { error: 'timeline query parameter is required' });
      sendJson(res, 200, await pixera.getTimelineCues(timeline));
    },
  },
  {
    // Fade a timeline to a cue's time and land playing (1) or paused (2).
    method: 'POST',
    pattern: /^\/api\/timelines\/blend$/,
    handler: async (req, res) => {
      const { timelineName, timeHMSF, transportMode, fadeMs } = await readJsonBody(req);
      const resolvedFade = Number.isFinite(Number(fadeMs)) ? Number(fadeMs) : store.settings.defaultFadeMs;
      const result = await pixera.blendToCue({
        timelineName,
        timeHMSF,
        transportMode,
        fadeMs: resolvedFade,
      });
      log.add({
        server: 'system',
        dir: 'info',
        data: `blend "${timelineName}" to ${timeHMSF} (${transportMode === 1 ? 'play' : 'pause'}, fade ${resolvedFade}ms) -> ${result.sentTo.join(', ')}`,
      });
      sendJson(res, 200, { ok: true, ...result });
    },
  },
  // ---- Show file management -------------------------------------------------
  {
    method: 'GET',
    pattern: /^\/api\/shows$/,
    handler: async (req, res) =>
      sendJson(res, 200, { shows: store.listShows(), active: store.activeFile }),
  },
  {
    // Create a blank show (connection settings carry over from the current one).
    method: 'POST',
    pattern: /^\/api\/shows$/,
    handler: async (req, res) => {
      const { name } = await readJsonBody(req);
      const file = store.createShow(name);
      sendJson(res, 201, { file, shows: store.listShows(), active: store.activeFile });
    },
  },
  {
    // Switch the active show; connections reconfigure and all clients refresh.
    method: 'POST',
    pattern: /^\/api\/shows\/active$/,
    handler: async (req, res) => {
      const { file } = await readJsonBody(req);
      store.switchShow(file);
      pixera.applySettings(store.settings);
      osc.configure(store.settings.shortcuts);
      log.add({ server: 'system', dir: 'info', data: `switched active show to "${store.activeFile}"` });
      broadcastState();
      sendJson(res, 200, { ok: true, active: store.activeFile });
    },
  },
  {
    // Upload a show file (saved to the library; not activated).
    method: 'POST',
    pattern: /^\/api\/shows\/import$/,
    handler: async (req, res) => {
      const { name, show } = await readJsonBody(req);
      const file = store.importShow(name, show);
      sendJson(res, 201, { file, shows: store.listShows(), active: store.activeFile });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/shows\/([^/]+)\/download$/,
    handler: async (req, res, [, encoded]) => {
      const { file, text } = store.readShowRaw(decodeURIComponent(encoded));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      });
      res.end(text);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/shows\/([^/]+)$/,
    handler: async (req, res, [, encoded]) => {
      store.deleteShow(decodeURIComponent(encoded));
      sendJson(res, 200, { ok: true, shows: store.listShows(), active: store.activeFile });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/log$/,
    handler: async (req, res) => sendJson(res, 200, { entries: log.recent(1000) }),
  },
  {
    // Debug helper: fetch getTimelineInfosAsJsonString for a timeline
    // (?timeline=Name, defaults to the selected timeline). Open in a browser.
    method: 'GET',
    pattern: /^\/api\/debug\/timeline-info$/,
    handler: async (req, res, match, url) => {
      const conn = pixera.preferred();
      if (!conn) return sendJson(res, 503, { error: 'no Pixera server connected' });
      const name =
        url.searchParams.get('timeline') || pixera.playback.selectedTimelineName;
      if (!name) return sendJson(res, 409, { error: 'no timeline given or selected' });
      const handle = await conn.request('Pixera.Timelines.getTimelineFromName', { name });
      if (handle == null) return sendJson(res, 404, { error: `timeline not found: ${name}` });
      const raw = await conn.request('Pixera.Timelines.Timeline.getTimelineInfosAsJsonString', {
        handle,
      });
      let parsed = null;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        /* leave parsed null; raw still returned */
      }
      sendJson(res, 200, { server: conn.name, timeline: name, raw, parsed });
    },
  },
  {
    // Debug helper: send an arbitrary read query to Pixera.
    // curl -X POST /api/debug/rpc -d '{"method":"Pixera...","params":{...}}'
    method: 'POST',
    pattern: /^\/api\/debug\/rpc$/,
    handler: async (req, res) => {
      const { method, params, server } = await readJsonBody(req);
      if (typeof method !== 'string' || !method.startsWith('Pixera.')) {
        return sendJson(res, 400, { error: 'method must be a "Pixera.*" string' });
      }
      const conn = server ? pixera.connections[server] : pixera.preferred();
      if (!conn?.isConnected) return sendJson(res, 503, { error: 'server not connected' });
      const result = await conn.request(method, params);
      sendJson(res, 200, { server: conn.name, result });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async (req, res) => sendJson(res, 200, { ok: true }),
  },
];

// ---------------------------------------------------------------------------
// Static file serving (built web UI)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(WEB_DIST, safePath);
  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_DIST, 'index.html'); // SPA fallback
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Web UI not built. Run: npm run build:web');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const route of routes) {
      const match = url.pathname.match(route.pattern);
      if (match && req.method === route.method) {
        await route.handler(req, res, match, url);
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (err) {
    log.add({ server: 'system', dir: 'error', data: `${req.method} ${url.pathname}: ${err.message}` });
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Lexicon Raptor listening on http://0.0.0.0:${PORT}`);
  console.log(`Show file: ${path.join(DATA_DIR, 'show.json')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    osc.close();
    pixera.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
