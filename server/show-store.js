/**
 * ShowStore — persistence for show files (settings + cue list).
 *
 * The data dir can hold any number of show files (*.json); exactly one is
 * "active" at a time (tracked in config.json). Show files are deliberately
 * human-readable, pretty-printed JSON so they can be edited in a text editor
 * and copied between machines. Writes are atomic (temp file + rename) so a
 * crash can never corrupt a show.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CURRENT_VERSION = 1;
const CONFIG_FILE = 'config.json';
const DEFAULT_SHOW_FILE = 'show.json';

function defaultShow() {
  return {
    version: CURRENT_VERSION,
    settings: {
      primary: { ip: '', port: 1400, enabled: false },
      backup: { ip: '', port: 1400, enabled: false },
      defaultFadeMs: 1000,
      shortcuts: {
        keyboardEnabled: false, // Space = play/pause toggle in the browser
        oscEnabled: false, // UDP OSC listener (/raptor/go etc.)
        oscPort: 8100,
      },
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

function sanitizeShortcuts(input, fallback) {
  const out = { ...fallback };
  if (input && typeof input === 'object') {
    if (typeof input.keyboardEnabled === 'boolean') out.keyboardEnabled = input.keyboardEnabled;
    if (typeof input.oscEnabled === 'boolean') out.oscEnabled = input.oscEnabled;
    const port = Number(input.oscPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) out.oscPort = port;
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

/**
 * Turn a user-supplied show name into a safe *.json filename inside the data
 * dir: strips path separators and anything exotic; rejects empty results.
 */
export function sanitizeShowFilename(name) {
  const base = String(name ?? '')
    .trim()
    .replace(/\.json$/i, '')
    .replace(/[^\w .()-]+/g, '')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!base) throw new Error('invalid show file name');
  return `${base}.json`;
}

/** Sanitize a full parsed show object (used by load and import). */
function sanitizeShow(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('show file must be a JSON object');
  }
  const base = defaultShow();
  return {
    version: CURRENT_VERSION,
    settings: {
      primary: sanitizeServer(data.settings?.primary, base.settings.primary),
      backup: sanitizeServer(data.settings?.backup, base.settings.backup),
      defaultFadeMs:
        Number.isFinite(Number(data.settings?.defaultFadeMs)) &&
        Number(data.settings.defaultFadeMs) >= 0
          ? Math.round(Number(data.settings.defaultFadeMs))
          : base.settings.defaultFadeMs,
      shortcuts: sanitizeShortcuts(data.settings?.shortcuts, base.settings.shortcuts),
    },
    cues: Array.isArray(data.cues)
      ? data.cues.map((c) => ({ id: c.id || crypto.randomUUID(), ...sanitizeCueInput(c) }))
      : [],
  };
}

function atomicWrite(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.show-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

export class ShowStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.activeFile = DEFAULT_SHOW_FILE;
    this.show = defaultShow();
    fs.mkdirSync(dataDir, { recursive: true });
    this.loadConfig();
    this.load();
  }

  get filePath() {
    return path.join(this.dataDir, this.activeFile);
  }

  loadConfig() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.dataDir, CONFIG_FILE), 'utf8'));
      if (typeof cfg.activeShow === 'string') {
        this.activeFile = sanitizeShowFilename(cfg.activeShow);
      }
    } catch {
      /* missing/corrupt config: fall back to show.json */
    }
  }

  saveConfig() {
    atomicWrite(
      path.join(this.dataDir, CONFIG_FILE),
      JSON.stringify({ activeShow: this.activeFile }, null, 2) + '\n'
    );
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      this.show = sanitizeShow(JSON.parse(text));
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
    atomicWrite(this.filePath, JSON.stringify(this.show, null, 2) + '\n');
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
      shortcuts: sanitizeShortcuts(input.shortcuts, s.shortcuts),
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

  // ---- Show file management ------------------------------------------------

  /** All show files in the data dir with lightweight metadata. */
  listShows() {
    const files = fs
      .readdirSync(this.dataDir)
      .filter((f) => f.endsWith('.json') && f !== CONFIG_FILE && !f.includes('.invalid-'));
    return files
      .map((file) => {
        const full = path.join(this.dataDir, file);
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch {
          return null;
        }
        let cueCount = null;
        let valid = true;
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf8'));
          cueCount = Array.isArray(data.cues) ? data.cues.length : 0;
        } catch {
          valid = false;
        }
        return {
          file,
          cueCount,
          valid,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          active: file === this.activeFile,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  resolveShowPath(name) {
    const file = sanitizeShowFilename(name);
    return { file, full: path.join(this.dataDir, file) };
  }

  /** Create a blank show. Connection settings carry over from the current show. */
  createShow(name) {
    const { file, full } = this.resolveShowPath(name);
    if (fs.existsSync(full)) throw new Error(`show file already exists: ${file}`);
    const blank = defaultShow();
    blank.settings = structuredClone(this.show.settings);
    atomicWrite(full, JSON.stringify(blank, null, 2) + '\n');
    return file;
  }

  /** Save an uploaded show object as a new file (sanitized, never activated). */
  importShow(name, data) {
    const { file, full } = this.resolveShowPath(name);
    if (fs.existsSync(full)) throw new Error(`show file already exists: ${file}`);
    const show = sanitizeShow(data);
    atomicWrite(full, JSON.stringify(show, null, 2) + '\n');
    return file;
  }

  /** Switch the active show. The previous show is already saved on disk. */
  switchShow(name) {
    const { file, full } = this.resolveShowPath(name);
    if (!fs.existsSync(full)) throw new Error(`show file not found: ${file}`);
    this.activeFile = file;
    this.saveConfig();
    this.load();
    return this.show;
  }

  deleteShow(name) {
    const { file, full } = this.resolveShowPath(name);
    if (file === this.activeFile) throw new Error('cannot delete the active show — load another one first');
    if (!fs.existsSync(full)) throw new Error(`show file not found: ${file}`);
    fs.rmSync(full);
  }

  /** Raw file text for download. */
  readShowRaw(name) {
    const { file, full } = this.resolveShowPath(name);
    if (!fs.existsSync(full)) throw new Error(`show file not found: ${file}`);
    return { file, text: fs.readFileSync(full, 'utf8') };
  }
}
