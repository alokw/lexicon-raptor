import React from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

const TRANSPORT_LABELS = { 1: 'PLAYING', 2: 'PAUSED', 3: 'STOPPED' };
const HELP_URL = 'https://github.com/alokw/lexicon-raptor';

function StatusDot({ status }) {
  return <span className={`dot dot-${status}`} title={status} />;
}

/** Slim row: enable toggle + status dot. IPs live in the Settings panel. */
function ServerRow({ label, serverKey }) {
  const { state, toast } = useStore();
  const settings = state.settings[serverKey];
  const conn = state.connections[serverKey] || {};

  async function setEnabled(enabled) {
    try {
      await api.updateSettings({ [serverKey]: { ...settings, enabled } });
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <div className="server-row" title={settings.ip ? `${settings.ip}:${settings.port}` : 'No IP set — open Settings'}>
      <span className="server-label">{label}</span>
      <label className="switch" title={`Enable/disable ${label.toLowerCase()} server`}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="slider" />
      </label>
      <StatusDot status={conn.status || 'disabled'} />
    </div>
  );
}

function ViewSwitcher() {
  const { state, dispatch } = useStore();
  return (
    <div className="view-switcher" role="tablist">
      <button
        role="tab"
        className={state.view === 'shortcuts' ? 'active' : ''}
        onClick={() => dispatch({ type: 'setView', view: 'shortcuts' })}
      >
        Shortcuts
      </button>
      <button
        role="tab"
        className={state.view === 'cuelist' ? 'active' : ''}
        onClick={() => dispatch({ type: 'setView', view: 'cuelist' })}
      >
        Cue List
      </button>
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
      <button
        className="tbtn tbtn-play-big"
        disabled={disabled}
        onClick={() => send('play')}
        title="Play selected timeline"
      >
        ▶
      </button>
      <div className="transport-main">
        <div className="timeline-feedback">
          <div className="timeline-name" title="Timeline currently selected in Pixera">
            {playback.selectedTimelineName || (anyConnected ? 'No timeline selected' : 'Offline')}
            {playback.source && (
              <span
                className={`via-tag via-${playback.source}`}
                title={`Feedback is read from the ${playback.source} server (primary is preferred while connected)`}
              >
                via {playback.source}
              </span>
            )}
          </div>
          <div className="timeline-times">
            <span className={`transport-state mode-${playback.transportMode || 0}`}>
              {transportLabel}
            </span>
            <span className="time" title="Elapsed (h:m:s:f)">
              ⏱ {playback.currentHMSF || '--:--:--:--'}
            </span>
          </div>
          <div className="next-cue" title="Next cue on the timeline and countdown to it">
            {playback.countdownHMSF ? (
              <>
                Next:{' '}
                <strong>
                  {playback.nextCueName ||
                    (playback.nextCueNumber ? `#${playback.nextCueNumber}` : 'cue')}
                </strong>{' '}
                <span className="time">⏳ {playback.countdownHMSF}</span>
              </>
            ) : (
              'Next: —'
            )}
          </div>
        </div>
        <div className="transport-buttons">
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
    </div>
  );
}

export default function Header({ onOpenDebug, onOpenSettings, onOpenFiles }) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="brand">
          <div className="brand-title">
            <span className="brand-icon">🦖</span>
            <h1>Lexicon Raptor</h1>
          </div>
          <ViewSwitcher />
        </div>
        <div className="server-controls">
          <ServerRow label="Primary" serverKey="primary" />
          <ServerRow label="Backup" serverKey="backup" />
        </div>
      </div>
      <div className="header-right">
        <TransportPanel />
        <div className="header-menu">
          <button className="menu-btn" onClick={onOpenFiles} title="Manage show files (export, import, switch)">
            File Mgmt
          </button>
          <button className="menu-btn" onClick={onOpenSettings} title="Server IPs, fade time, shortcuts">
            Settings
          </button>
          <button className="menu-btn" onClick={onOpenDebug} title="Communication log">
            Debug
          </button>
          <a
            className="menu-btn"
            href={HELP_URL}
            target="_blank"
            rel="noreferrer"
            title="Documentation on GitHub"
          >
            Help
          </a>
        </div>
      </div>
    </header>
  );
}
