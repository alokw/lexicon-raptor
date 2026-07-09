/**
 * ShowStore — persistence for the show file (settings + cue list).
 *
 * The show file is deliberately human-readable, pretty-printed JSON so it can
 * be edited in a text editor and copied between machines. Writes are atomic
 * (temp file + rename) so a crash can never corrupt the show.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CURRENT_VERSION = 1;

function defaultShow() {
  return {
    version: CURRENT_VERSION,
    settings: {
      primary: { ip: '', port: 1400, enabled: false },
      backup: { ip: '', port: 1400, enabled: false },
      defaultFadeMs: 1000,
    },
    cues: [],
  };
}

function sanitizeServer(input, fallback) {
  const out = { ...fallback };
  if (input && typeof input === 'object') {
    if (typeof input.ip === 'string') out.ip = input.ip.trim();
    const port = Number(input.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) out.port = port;
    if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  }
  return out;
}

export function sanitizeCueInput(input = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  let fadeMs = null;
  if (input.fadeMs !== null && input.fadeMs !== undefined && input.fadeMs !== '') {
    const n = Number(input.fadeMs);
    if (!Number.isFinite(n) || n < 0) throw new Error('fadeMs must be a non-negative number');
    fadeMs = Math.round(n);
  }
  // Optional display color (#rrggbb). Lenient: anything else becomes null.
  let color = null;
  if (typeof input.color === 'string') {
    const m = input.color.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (m) color = `#${m[1].toLowerCase()}`;
  }
  return {
    label: str(input.label),
    cueName: str(input.cueName),
    timelineName: str(input.timelineName),
    fadeMs,
    notes: str(input.notes),
    color,
  };
}

export class ShowStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.show = defaultShow();
    this.load();
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text);
      const base = defaultShow();
      this.show = {
        version: CURRENT_VERSION,
        settings: {
          primary: sanitizeServer(data.settings?.primary, base.settings.primary),
          backup: sanitizeServer(data.settings?.backup, base.settings.backup),
          defaultFadeMs:
            Number.isFinite(Number(data.settings?.defaultFadeMs)) &&
            Number(data.settings.defaultFadeMs) >= 0
              ? Math.round(Number(data.settings.defaultFadeMs))
              : base.settings.defaultFadeMs,
        },
        cues: Array.isArray(data.cues)
          ? data.cues.map((c) => ({ id: c.id || crypto.randomUUID(), ...sanitizeCueInput(c) }))
          : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Never silently discard a corrupt show file: keep it for inspection.
        const backup = `${this.filePath}.invalid-${Date.now()}`;
        try {
          fs.copyFileSync(this.filePath, backup);
          console.error(`show file unreadable (${err.message}); backed up to ${backup}`);
        } catch {
          /* ignore */
        }
      }
      this.show = defaultShow();
      this.save();
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.show-${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.show, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get settings() {
    return this.show.settings;
  }

  get cues() {
    return this.show.cues;
  }

  updateSettings(input) {
    const s = this.show.settings;
    const next = {
      primary: sanitizeServer(input.primary, s.primary),
      backup: sanitizeServer(input.backup, s.backup),
      defaultFadeMs: s.defaultFadeMs,
    };
    if (input.defaultFadeMs !== undefined) {
      const n = Number(input.defaultFadeMs);
      if (!Number.isFinite(n) || n < 0) throw new Error('defaultFadeMs must be a non-negative number');
      next.defaultFadeMs = Math.round(n);
    }
    this.show.settings = next;
    this.save();
    return next;
  }

  addCue(input) {
    const cue = { id: crypto.randomUUID(), ...sanitizeCueInput(input) };
    if (!cue.cueName) throw new Error('cue name is required');
    this.show.cues.push(cue);
    this.save();
    return cue;
  }

  updateCue(id, input) {
    const idx = this.show.cues.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('cue not found');
    const merged = { ...this.show.cues[idx], ...sanitizeCueInput({ ...this.show.cues[idx], ...input }) };
    if (!merged.cueName) throw new Error('cue name is required');
    this.show.cues[idx] = merged;
    this.save();
    return merged;
  }

  deleteCue(id) {
    const before = this.show.cues.length;
    this.show.cues = this.show.cues.filter((c) => c.id !== id);
    if (this.show.cues.length === before) throw new Error('cue not found');
    this.save();
  }

  reorderCues(ids) {
    const byId = new Map(this.show.cues.map((c) => [c.id, c]));
    if (ids.length !== byId.size || ids.some((id) => !byId.has(id))) {
      throw new Error('reorder list must contain exactly the existing cue ids');
    }
    this.show.cues = ids.map((id) => byId.get(id));
    this.save();
    return this.show.cues;
  }

  getCue(id) {
    return this.show.cues.find((c) => c.id === id) || null;
  }
}
