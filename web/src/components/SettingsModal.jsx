import React, { useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

function ServerFields({ label, value, onChange }) {
  return (
    <div className="settings-server">
      <span className="field-label">{label}</span>
      <label className="field">
        <span>IP address</span>
        <input
          type="text"
          placeholder="0.0.0.0"
          spellCheck={false}
          value={value.ip}
          onChange={(e) => onChange({ ...value, ip: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Port</span>
        <input
          type="number"
          min="1"
          max="65535"
          value={value.port}
          onChange={(e) => onChange({ ...value, port: e.target.value })}
        />
      </label>
    </div>
  );
}

export default function SettingsModal({ onClose }) {
  const { state, toast } = useStore();
  const s = state.settings;

  const [primary, setPrimary] = useState({ ip: s.primary.ip, port: s.primary.port });
  const [backup, setBackup] = useState({ ip: s.backup.ip, port: s.backup.port });
  const [fadeMs, setFadeMs] = useState(String(s.defaultFadeMs));
  const [keyboardEnabled, setKeyboardEnabled] = useState(!!s.shortcuts?.keyboardEnabled);
  const [oscEnabled, setOscEnabled] = useState(!!s.shortcuts?.oscEnabled);
  const [oscPort, setOscPort] = useState(String(s.shortcuts?.oscPort ?? 8100));
  const [saving, setSaving] = useState(false);

  async function save() {
    const fade = Number(fadeMs);
    if (!Number.isFinite(fade) || fade < 0) {
      toast('Fade time must be a non-negative number of milliseconds');
      return;
    }
    const osc = Number(oscPort);
    if (oscEnabled && (!Number.isInteger(osc) || osc < 1 || osc > 65535)) {
      toast('OSC port must be a valid port number (1–65535)');
      return;
    }
    setSaving(true);
    try {
      // Enable toggles live in the header — preserve their current values.
      await api.updateSettings({
        primary: { ip: primary.ip.trim(), port: Number(primary.port), enabled: s.primary.enabled },
        backup: { ip: backup.ip.trim(), port: Number(backup.port), enabled: s.backup.enabled },
        defaultFadeMs: Math.round(fade),
        shortcuts: { keyboardEnabled, oscEnabled, oscPort: osc || 8100 },
      });
      toast('Settings saved', 'ok');
      onClose();
    } catch (err) {
      toast(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Settings</h2>
          <div className="modal-header-actions">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="modal-body settings-body">
          <section className="settings-section">
            <h3>Pixera servers</h3>
            <p className="hint">
              Enable/disable toggles and connection status stay in the header for quick access.
            </p>
            <div className="settings-servers">
              <ServerFields label="Primary" value={primary} onChange={setPrimary} />
              <ServerFields label="Backup" value={backup} onChange={setBackup} />
            </div>
          </section>

          <section className="settings-section">
            <h3>Fades</h3>
            <label className="field settings-inline">
              <span>Default fade time (ms)</span>
              <input
                type="number"
                min="0"
                step="100"
                value={fadeMs}
                onChange={(e) => setFadeMs(e.target.value)}
              />
            </label>
            <p className="hint">
              Used by GO buttons without their own fade time, the header fade buttons, and
              fade-to-cue in the Cue List view.
            </p>
          </section>

          <section className="settings-section">
            <h3>Remote control</h3>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={keyboardEnabled}
                onChange={(e) => setKeyboardEnabled(e.target.checked)}
              />
              <span>
                Keyboard shortcuts
                <small>Space = play the selected timeline (pause if it is already playing).</small>
              </span>
            </label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={oscEnabled}
                onChange={(e) => setOscEnabled(e.target.checked)}
              />
              <span>
                OSC commands (UDP)
                <small>
                  <code>/raptor/go</code> = play/pause toggle · also <code>/raptor/play</code>,{' '}
                  <code>/raptor/pause</code>, <code>/raptor/stop</code>. When running in Docker, the
                  UDP port must be published in docker-compose.
                </small>
              </span>
            </label>
            {oscEnabled && (
              <label className="field settings-inline settings-indent">
                <span>OSC port (UDP)</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={oscPort}
                  onChange={(e) => setOscPort(e.target.value)}
                />
              </label>
            )}
          </section>
        </div>

        <footer className="modal-footer">
          <span className="hint">Settings are stored in the active show file.</span>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
