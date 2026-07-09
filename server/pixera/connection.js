/**
 * PixeraConnection — a single TCP connection to one Pixera instance.
 *
 * Speaks JSON-RPC 2.0 over Pixera's "pxr1" framing:
 *   [ 'p' 'x' 'r' '1' ][ uint32 LE payload size ][ payload (UTF-8 JSON) ]
 * (Pixera API settings port mode must be "JSON/TCP".)
 *
 * Responsibilities:
 *  - connect / auto-reconnect with backoff
 *  - request/response matching by JSON-RPC id, with timeouts
 *  - heartbeat to detect half-open sockets
 *  - emits: 'status' (status string), 'traffic' ({dir, data}), 'unmatched' (msg)
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';

const FRAME_TAG = Buffer.from('pxr1', 'ascii');
const HEADER_SIZE = 8;

export const STATUS = {
  DISABLED: 'disabled',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
};

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 2500;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class PixeraConnection extends EventEmitter {
  constructor(name) {
    super();
    this.name = name; // 'primary' | 'backup'
    this.ip = '';
    this.port = 1400;
    this.enabled = false;

    this.socket = null;
    this.status = STATUS.DISABLED;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer, method}
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  configure({ ip, port, enabled }) {
    const changed =
      ip !== this.ip || (port || 1400) !== this.port || enabled !== this.enabled;
    this.ip = ip || '';
    this.port = port || 1400;
    this.enabled = !!enabled;
    if (!changed) return;

    this.teardown();
    if (this.enabled && this.ip) {
      this.connect();
    } else {
      this.setStatus(STATUS.DISABLED);
    }
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  get isConnected() {
    return this.status === STATUS.CONNECTED;
  }

  connect() {
    if (this.socket) return;
    this.setStatus(STATUS.CONNECTING);
    const socket = net.connect({ host: this.ip, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on('connect', () => {
      if (socket !== this.socket) return;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setStatus(STATUS.CONNECTED);
      this.emit('traffic', { dir: 'info', data: `connected to ${this.ip}:${this.port}` });
      this.startHeartbeat();
    });

    socket.on('data', (chunk) => {
      if (socket !== this.socket) return;
      this.onData(chunk);
    });

    socket.on('error', (err) => {
      if (socket !== this.socket) return;
      this.emit('traffic', { dir: 'error', data: `socket error: ${err.message}` });
    });

    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.onSocketClosed();
    });
  }

  onSocketClosed() {
    this.stopHeartbeat();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.failAllPending(new Error('connection closed'));
    if (this.enabled && this.ip) {
      this.setStatus(STATUS.DISCONNECTED);
      this.scheduleReconnect();
    } else {
      this.setStatus(STATUS.DISABLED);
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      if (this.enabled && this.ip && !this.socket) this.connect();
    }, delay);
  }

  teardown() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.stopHeartbeat();
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.destroy();
    }
    this.buffer = Buffer.alloc(0);
    this.failAllPending(new Error('connection reset'));
  }

  failAllPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected || this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      try {
        await this.request('Pixera.Utility.getApiRevision', undefined, {
          timeoutMs: HEARTBEAT_TIMEOUT_MS,
          quiet: true,
        });
      } catch {
        this.emit('traffic', { dir: 'error', data: 'heartbeat timed out; resetting connection' });
        if (this.socket) this.socket.destroy();
      } finally {
        this.heartbeatInFlight = false;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_SIZE) {
      if (!this.buffer.subarray(0, 4).equals(FRAME_TAG)) {
        // Stream out of sync — try to resync on the next tag occurrence.
        const idx = this.buffer.indexOf(FRAME_TAG, 1);
        this.emit('traffic', { dir: 'error', data: 'framing desync; attempting resync' });
        if (idx === -1) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.buffer = this.buffer.subarray(idx);
        continue;
      }
      const size = this.buffer.readUInt32LE(4);
      if (this.buffer.length < HEADER_SIZE + size) return; // wait for more data
      const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + size);
      this.buffer = this.buffer.subarray(HEADER_SIZE + size);
      this.handleMessage(payload.toString('utf8'));
    }
  }

  handleMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.emit('traffic', { dir: 'error', data: `unparseable message: ${text.slice(0, 500)}` });
      return;
    }
    const entry = msg.id != null ? this.pending.get(msg.id) : null;
    if (!entry || !entry.quiet) {
      this.emit('traffic', { dir: 'rx', data: text });
    }
    if (entry) {
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
    } else {
      // Unsolicited message (e.g. monitoring event) — surface for future use.
      this.emit('unmatched', msg);
    }
  }

  /**
   * Send a JSON-RPC request. Resolves with `result`, rejects on error/timeout.
   * opts.quiet suppresses traffic logging (used for heartbeats/polling noise control).
   */
  request(method, params, opts = {}) {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, quiet = false } = opts;
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.socket) {
        reject(new Error(`${this.name} not connected`));
        return;
      }
      const id = this.nextId++;
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      const text = JSON.stringify(msg);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, quiet });

      if (!quiet) this.emit('traffic', { dir: 'tx', data: text });
      const payload = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(HEADER_SIZE);
      FRAME_TAG.copy(header, 0);
      header.writeUInt32LE(payload.length, 4);
      this.socket.write(Buffer.concat([header, payload]));
    });
  }
}
