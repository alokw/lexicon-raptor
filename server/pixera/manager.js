/**
 * PixeraManager — orchestrates the primary and backup connections.
 *
 * Command fan-out: control actions (fire cue, transport, fades) are sent to
 * every enabled+connected server using *name-based* Compound calls, so the
 * identical command works on both machines (handles differ per server).
 *
 * Reads (status feedback, import enumeration) go to the "preferred" server:
 * primary if connected, otherwise backup.
 *
 * Emits: 'playback' (playback state object), 'connections' (status map),
 *        'log' (comms log entry)
 */
import { EventEmitter } from 'node:events';
import { PixeraConnection, STATUS } from './connection.js';

const POLL_INTERVAL_MS = 500;
const TRANSPORT_MODES = { play: 1, pause: 2, stop: 3 };

export class PixeraManager extends EventEmitter {
  constructor(log) {
    super();
    this.log = log; // CommsLog
    this.connections = {
      primary: new PixeraConnection('primary'),
      backup: new PixeraConnection('backup'),
    };
    for (const [name, conn] of Object.entries(this.connections)) {
      conn.on('traffic', (entry) => this.log.add({ server: name, ...entry }));
      conn.on('status', () => this.emit('connections', this.getConnectionStates()));
    }

    this.playback = {
      selectedTimelineName: null,
      transportMode: null, // 1 play, 2 pause, 3 stop
      currentHMSF: null,
      countdownHMSF: null,
    };
    this._selectedHandleCache = { server: null, handle: null, name: null };
    this._pollTimer = null;
    this._polling = false;
  }

  applySettings(settings) {
    this.connections.primary.configure(settings.primary);
    this.connections.backup.configure(settings.backup);
    this.emit('connections', this.getConnectionStates());
  }

  getConnectionStates() {
    const out = {};
    for (const [name, conn] of Object.entries(this.connections)) {
      out[name] = { status: conn.status, ip: conn.ip, port: conn.port, enabled: conn.enabled };
    }
    return out;
  }

  /** Preferred server for read/feedback operations. */
  preferred() {
    if (this.connections.primary.isConnected) return this.connections.primary;
    if (this.connections.backup.isConnected) return this.connections.backup;
    return null;
  }

  activeConnections() {
    return Object.values(this.connections).filter((c) => c.isConnected);
  }

  /**
   * Send a command to all enabled+connected servers.
   * Succeeds if at least one server accepted it; reports per-server errors.
   */
  async sendToAll(method, params, opts) {
    const targets = this.activeConnections();
    if (targets.length === 0) {
      throw new Error('no Pixera server connected');
    }
    const results = await Promise.allSettled(
      targets.map((c) => c.request(method, params, opts))
    );
    const failures = results
      .map((r, i) => ({ r, name: targets[i].name }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, name }) => `${name}: ${r.reason.message}`);
    if (failures.length === targets.length) {
      throw new Error(failures.join('; '));
    }
    return { sentTo: targets.map((t) => t.name), failures };
  }

  // ---- Control actions -------------------------------------------------

  /**
   * Fire a cue by names. fadeMs is converted to Pixera's blendDuration (seconds).
   */
  async fireCue({ timelineName, cueName, fadeMs }) {
    const params = { timelineName, cueName };
    if (fadeMs != null && Number.isFinite(fadeMs)) {
      params.blendDuration = fadeMs / 1000;
    }
    return this.sendToAll('Pixera.Compound.applyCueOnTimeline', params, { timeoutMs: 3000 });
  }

  async transport(action, timelineName) {
    if (!timelineName) throw new Error('no timeline selected');
    const mode = TRANSPORT_MODES[action];
    if (!mode) throw new Error(`unknown transport action: ${action}`);
    return this.sendToAll(
      'Pixera.Compound.setTransportModeOnTimeline',
      { timelineName, mode },
      { timeoutMs: 3000 }
    );
  }

  async fadeOpacity(fadeIn, timelineName, fadeMs) {
    if (!timelineName) throw new Error('no timeline selected');
    return this.sendToAll(
      'Pixera.Compound.startOpacityAnimationOfTimeline',
      { name: timelineName, fadeIn, fullFadeDuration: (fadeMs ?? 1000) / 1000 },
      { timeoutMs: 3000 }
    );
  }

  // ---- Feedback polling --------------------------------------------------

  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
  }

  stopPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  async pollOnce() {
    if (this._polling) return; // don't stack slow polls
    this._polling = true;
    try {
      const conn = this.preferred();
      if (!conn) {
        this.updatePlayback({
          selectedTimelineName: null,
          transportMode: null,
          currentHMSF: null,
          countdownHMSF: null,
        });
        return;
      }
      const quiet = { timeoutMs: 2000, quiet: true };

      const handles = await conn.request('Pixera.Timelines.getTimelinesSelected', undefined, quiet);
      const handle = Array.isArray(handles) && handles.length > 0 ? handles[0] : null;
      if (handle == null) {
        this.updatePlayback({
          selectedTimelineName: null,
          transportMode: null,
          currentHMSF: null,
          countdownHMSF: null,
        });
        return;
      }

      // Resolve handle -> name only when the handle changes (cheap cache).
      const cache = this._selectedHandleCache;
      let name;
      if (cache.server === conn.name && cache.handle === handle && cache.name) {
        name = cache.name;
      } else {
        name = await conn.request('Pixera.Timelines.Timeline.getName', { handle }, quiet);
        this._selectedHandleCache = { server: conn.name, handle, name };
      }

      const [transportMode, currentHMSF, countdownHMSF] = await Promise.all([
        conn.request('Pixera.Compound.getTransportModeOnTimeline', { timelineName: name }, quiet),
        conn.request('Pixera.Compound.getCurrentHMSFOfTimeline', { name }, quiet),
        conn
          .request('Pixera.Compound.getCurrentCountdownHMSFOfTimeline', { name }, quiet)
          .catch(() => null),
      ]);

      this.updatePlayback({
        selectedTimelineName: name,
        transportMode,
        currentHMSF,
        countdownHMSF,
      });
    } catch (err) {
      // Polling errors are expected during reconnects; log once per occurrence.
      this.log.add({ server: 'system', dir: 'error', data: `poll failed: ${err.message}` });
    } finally {
      this._polling = false;
    }
  }

  updatePlayback(next) {
    const changed = Object.keys(next).some((k) => this.playback[k] !== next[k]);
    if (!changed) return;
    this.playback = { ...this.playback, ...next };
    this.emit('playback', this.playback);
  }

  // ---- Import: enumerate all cues on all timelines -----------------------

  /**
   * Returns [{timelineName, cues: [{name, number, numberFormatted, timeFrames, note}]}].
   * Prefers Timeline.getCueInfosAsJsonString (single round trip per timeline);
   * falls back to per-cue attribute requests if the JSON shape is unexpected.
   */
  async listAllCues() {
    const conn = this.preferred();
    if (!conn) throw new Error('no Pixera server connected');

    const names = await conn.request('Pixera.Timelines.getTimelineNames');
    const timelines = [];
    for (const timelineName of names || []) {
      try {
        const handle = await conn.request('Pixera.Timelines.getTimelineFromName', {
          name: timelineName,
        });
        if (handle == null) continue;
        const cues = await this.listCuesForTimeline(conn, handle);
        timelines.push({ timelineName, cues });
      } catch (err) {
        this.log.add({
          server: conn.name,
          dir: 'error',
          data: `cue enumeration failed for timeline "${timelineName}": ${err.message}`,
        });
        timelines.push({ timelineName, cues: [], error: err.message });
      }
    }
    return timelines;
  }

  async listCuesForTimeline(conn, handle) {
    // Fast path: one request per timeline.
    try {
      const raw = await conn.request('Pixera.Timelines.Timeline.getCueInfosAsJsonString', {
        handle,
      });
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const list = Array.isArray(parsed) ? parsed : parsed?.cues;
      if (Array.isArray(list)) {
        const cues = list
          .map((c) => ({
            name: c.name ?? c.cueName ?? null,
            number: c.number ?? null,
            numberFormatted: c.numberFormatted ?? null,
            timeFrames: c.time ?? null,
            note: c.note ?? '',
            operation: c.operation ?? null, // 1 Play, 2 Pause, 3 Stop, 4 Jump
          }))
          .filter((c) => c.name != null);
        if (cues.length === list.length) return cues;
      }
    } catch {
      // fall through to per-cue path
    }

    // Reliable path: per-cue requests.
    const cueHandles = (await conn.request('Pixera.Timelines.Timeline.getCues', { handle })) || [];
    const cues = [];
    for (const cueHandle of cueHandles) {
      const p = { handle: cueHandle };
      const [name, number, note, operation] = await Promise.all([
        conn.request('Pixera.Timelines.Cue.getName', p),
        conn.request('Pixera.Timelines.Cue.getNumber', p).catch(() => null),
        conn.request('Pixera.Timelines.Cue.getNote', p).catch(() => ''),
        conn.request('Pixera.Timelines.Cue.getOperation', p).catch(() => null),
      ]);
      cues.push({ name, number, numberFormatted: null, timeFrames: null, note, operation });
    }
    return cues;
  }

  shutdown() {
    this.stopPolling();
    for (const conn of Object.values(this.connections)) conn.teardown();
  }
}
