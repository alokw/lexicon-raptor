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
import { PixeraManager } from './pixera/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'web', 'dist');

const log = new CommsLog();
const store = new ShowStore(path.join(DATA_DIR, 'show.json'));
const pixera = new PixeraManager(log);

pixera.applySettings(store.settings);
pixera.startPolling();

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
log.on('entry', (entry) => broadcast({ type: 'log', entry }));

function fullState() {
  return {
    type: 'state',
    settings: store.settings,
    cues: store.cues,
    connections: pixera.getConnectionStates(),
    playback: pixera.playback,
  };
}

function broadcastState() {
  broadcast(fullState());
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(fullState()));
  ws.send(JSON.stringify({ type: 'logHistory', entries: log.recent(500) }));
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
      const { action } = await readJsonBody(req);
      const timelineName = pixera.playback.selectedTimelineName;
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
    method: 'GET',
    pattern: /^\/api\/log$/,
    handler: async (req, res) => sendJson(res, 200, { entries: log.recent(1000) }),
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
    pixera.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
