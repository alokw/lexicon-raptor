import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

const TRANSPORT_LABELS = { 1: 'PLAYING', 2: 'PAUSED', 3: 'STOPPED' };

function StatusDot({ status }) {
  return <span className={`dot dot-${status}`} title={status} />;
}

function ServerRow({ label, serverKey }) {
  const { state, toast } = useStore();
  const settings = state.settings[serverKey];
  const conn = state.connections[serverKey] || {};
  const [ip, setIp] = useState(settings.ip);

  // Keep local input in sync when another client changes it.
  useEffect(() => setIp(settings.ip), [settings.ip]);

  async function commit(next) {
    try {
      await api.updateSettings({ [serverKey]: { ...settings, ...next } });
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <div className="server-row">
      <span className="server-label">{label}</span>
      <input
        className="ip-input"
        type="text"
        placeholder="0.0.0.0"
        value={ip}
        spellCheck={false}
        onChange={(e) => setIp(e.target.value)}
        onBlur={() => ip.trim() !== settings.ip && commit({ ip: ip.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
      <label className="switch" title={`Enable/disable ${label.toLowerCase()} server`}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => commit({ enabled: e.target.checked })}
        />
        <span className="slider" />
      </label>
      <StatusDot status={conn.status || 'disabled'} />
    </div>
  );
}

function FadeTimeControl() {
  const { state, toast } = useStore();
  const [value, setValue] = useState(String(state.settings.defaultFadeMs));
  useEffect(() => setValue(String(state.settings.defaultFadeMs)), [state.settings.defaultFadeMs]);

  async function commit() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      toast('Fade time must be a non-negative number of milliseconds');
      setValue(String(state.settings.defaultFadeMs));
      return;
    }
    if (Math.round(n) === state.settings.defaultFadeMs) return;
    try {
      await api.updateSettings({ defaultFadeMs: Math.round(n) });
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <div className="fade-control">
      <label className="field-label" htmlFor="fade-ms">
        Fade time (ms)
      </label>
      <input
        id="fade-ms"
        className="fade-input"
        type="number"
        min="0"
        step="100"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
    </div>
  );
}

function TransportPanel() {
  const { state, toast } = useStore();
  const { playback } = state;
  const anyConnected = Object.values(state.connections).some((c) => c.status === 'connected');

  async function send(action) {
    try {
      await api.transport(action);
    } catch (err) {
      toast(err.message);
    }
  }

  const disabled = !anyConnected || !playback.selectedTimelineName;
  const transportLabel = TRANSPORT_LABELS[playback.transportMode] || '—';

  return (
    <div className="transport-panel">
      <div className="timeline-feedback">
        <div className="timeline-name" title="Timeline currently selected in Pixera">
          {playback.selectedTimelineName || (anyConnected ? 'No timeline selected' : 'Offline')}
        </div>
        <div className="timeline-times">
          <span className={`transport-state mode-${playback.transportMode || 0}`}>
            {transportLabel}
          </span>
          <span className="time" title="Elapsed (h:m:s:f)">
            ⏱ {playback.currentHMSF || '--:--:--:--'}
          </span>
          <span className="time" title="Countdown to next cue (h:m:s:f)">
            ⏳ {playback.countdownHMSF || '--:--:--:--'}
          </span>
        </div>
      </div>
      <div className="transport-buttons">
        <button className="tbtn" disabled={disabled} onClick={() => send('play')} title="Play">
          ▶
        </button>
        <button className="tbtn" disabled={disabled} onClick={() => send('pause')} title="Pause">
          ⏸
        </button>
        <button className="tbtn" disabled={disabled} onClick={() => send('stop')} title="Stop">
          ⏹
        </button>
        <button
          className="tbtn tbtn-wide"
          disabled={disabled}
          onClick={() => send('fadeUp')}
          title="Fade timeline opacity up (uses default fade time)"
        >
          Fade ↑
        </button>
        <button
          className="tbtn tbtn-wide"
          disabled={disabled}
          onClick={() => send('fadeDown')}
          title="Fade timeline opacity down (uses default fade time)"
        >
          Fade ↓
        </button>
      </div>
    </div>
  );
}

export default function Header({ onOpenDebug }) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="brand">
          <span className="brand-icon">🦖</span>
          <h1>Lexicon Raptor</h1>
        </div>
        <div className="server-controls">
          <ServerRow label="Primary" serverKey="primary" />
          <ServerRow label="Backup" serverKey="backup" />
        </div>
        <FadeTimeControl />
      </div>
      <div className="header-right">
        <TransportPanel />
        <button className="debug-btn" onClick={onOpenDebug} title="Communication log">
          Debug
        </button>
      </div>
    </header>
  );
}
