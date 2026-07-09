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
// getTimelineInfosAsJsonString reports Mode as a string (capital M).
const TRANSPORT_MODE_FROM_STRING = { play: 1, pause: 2, stop: 3 };

/**
 * Normalize a cue operation to 'play' | 'pause' | 'stop' | 'jump' | null.
 * Real rev-481 hardware returns strings ("Pause") in getCueInfosAsJsonString,
 * while Cue.getOperation returns the int enum (1=Play 2=Pause 3=Stop 4=Jump).
 */
const OP_BY_INT = { 1: 'play', 2: 'pause', 3: 'stop', 4: 'jump' };
export function normalizeOperation(op) {
  if (typeof op === 'number') return OP_BY_INT[op] ?? null;
  if (typeof op === 'string') {
    const s = op.trim().toLowerCase();
    return ['play', 'pause', 'stop', 'jump'].includes(s) ? s : null;
  }
  return null;
}

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
      nextCueName: null,
      nextCueNumber: null,
      source: null, // which server feedback comes from: 'primary' | 'backup' | null
    };
    this._selectedHandleCache = { server: null, handle: null, name: null };
    this._pollTimer = null;
    this._polling = false;
    this._legacyPoll = false; // sticky: getTimelineInfosAsJsonString unavailable
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
        this.updatePlayback(this.emptyPlayback(null));
        return;
      }
      const quiet = { timeoutMs: 2000, quiet: true };

      const handles = await conn.request('Pixera.Timelines.getTimelinesSelected', undefined, quiet);
      const handle = Array.isArray(handles) && handles.length > 0 ? handles[0] : null;
      if (handle == null) {
        this.updatePlayback(this.emptyPlayback(conn.name));
        return;
      }

      // Fast path: one request returns name, mode, time, and next cue.
      let playback = null;
      if (!this._legacyPoll) {
        try {
          playback = await this.pollViaTimelineInfos(conn, handle, quiet);
        } catch (err) {
          if (/timed out|not connected|connection/i.test(err.message)) throw err; // transient — retry next tick
          // Structural failure (method missing / shape change): fall back for good.
          this._legacyPoll = true;
          this.log.add({
            server: conn.name,
            dir: 'info',
            data: `getTimelineInfosAsJsonString unusable (${err.message}); using legacy polling`,
          });
        }
      }
      if (!playback) playback = await this.pollLegacy(conn, handle, quiet);

      this.updatePlayback(playback);
    } catch (err) {
      // Polling errors are expected during reconnects; log once per occurrence.
      this.log.add({ server: 'system', dir: 'error', data: `poll failed: ${err.message}` });
    } finally {
      this._polling = false;
    }
  }

  emptyPlayback(source) {
    return {
      selectedTimelineName: null,
      transportMode: null,
      currentHMSF: null,
      countdownHMSF: null,
      nextCueName: null,
      nextCueNumber: null,
      source,
    };
  }

  /**
   * Consolidated feedback: Timeline.getTimelineInfosAsJsonString (verified on
   * rev-481 hardware) returns {Mode, fps, index, name, nextcue, opacity,
   * smptemode, time} in a single round trip.
   */
  async pollViaTimelineInfos(conn, handle, quiet) {
    const raw = await conn.request(
      'Pixera.Timelines.Timeline.getTimelineInfosAsJsonString',
      { handle },
      quiet
    );
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!info || typeof info.name !== 'string') {
      throw new Error('unexpected timeline info shape');
    }
    const nextcue = info.nextcue && typeof info.nextcue === 'object' ? info.nextcue : null;
    return {
      selectedTimelineName: info.name,
      transportMode: TRANSPORT_MODE_FROM_STRING[String(info.Mode).toLowerCase()] ?? null,
      currentHMSF: info.time ?? null,
      countdownHMSF: nextcue?.countdown ?? null,
      nextCueName: nextcue ? nextcue.name || null : null,
      nextCueNumber: nextcue?.formattedNumber ?? null,
      source: conn.name,
    };
  }

  /** Legacy fallback: three Compound calls (pre-rev-481 safety net). */
  async pollLegacy(conn, handle, quiet) {
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

    return {
      selectedTimelineName: name,
      transportMode,
      currentHMSF,
      countdownHMSF,
      nextCueName: null,
      nextCueNumber: null,
      source: conn.name,
    };
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
    // Fast path: one request per timeline. Reply shape verified on rev-481
    // hardware: JSON array of {name, number, formattedNumber, time (HMSF
    // string), note, operation ("Play"|"Pause"|"Stop"|"Jump"), index, handle,
    // color, countdown, jumpmode, jumpgoal, waitDuration}.
    try {
      const raw = await conn.request('Pixera.Timelines.Timeline.getCueInfosAsJsonString', {
        handle,
      });
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const list = Array.isArray(parsed) ? parsed : parsed?.cues;
      if (Array.isArray(list)) {
        const cues = list
          .map((c, i) => ({
            name: typeof c.name === 'string' ? c.name : (c.cueName ?? null),
            number: c.number ?? null,
            numberFormatted: c.formattedNumber ?? c.numberFormatted ?? null,
            time: c.time ?? null, // HMSF string, e.g. "00:08:23:51"
            note: c.note ?? '',
            operation: normalizeOperation(c.operation),
            index: c.index ?? i,
            color: typeof c.color === 'string' ? c.color : null, // '#000000' = Pixera default
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
    for (let i = 0; i < cueHandles.length; i++) {
      const p = { handle: cueHandles[i] };
      const [name, number, note, operation] = await Promise.all([
        conn.request('Pixera.Timelines.Cue.getName', p),
        conn.request('Pixera.Timelines.Cue.getNumber', p).catch(() => null),
        conn.request('Pixera.Timelines.Cue.getNote', p).catch(() => ''),
        conn.request('Pixera.Timelines.Cue.getOperation', p).catch(() => null),
      ]);
      cues.push({
        name,
        number,
        numberFormatted: null,
        time: null,
        note,
        operation: normalizeOperation(operation),
        index: i,
        color: null,
      });
    }
    return cues;
  }

  shutdown() {
    this.stopPolling();
    for (const conn of Object.values(this.connections)) conn.teardown();
  }
}
