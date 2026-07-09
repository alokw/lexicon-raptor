import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'primary', label: 'Primary' },
  { id: 'backup', label: 'Backup' },
  { id: 'error', label: 'Errors' },
];

const DIR_SYMBOLS = { tx: '→', rx: '←', info: 'ℹ', error: '✕' };

export default function DebugModal({ onClose }) {
  const { state } = useStore();
  const [tab, setTab] = useState('all');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState([]);
  const bodyRef = useRef(null);

  const entries = paused ? frozen : state.log;
  const visible = entries.filter((e) => {
    if (tab === 'all') return true;
    if (tab === 'error') return e.dir === 'error';
    return e.server === tab;
  });

  // Auto-scroll to newest unless paused.
  useEffect(() => {
    if (!paused && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [visible.length, paused, tab]);

  function togglePause() {
    if (!paused) setFrozen(state.log);
    setPaused(!paused);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal debug-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Communication log</h2>
          <div className="modal-header-actions">
            <button className={`btn ${paused ? 'btn-primary' : ''}`} onClick={togglePause}>
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="debug-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body debug-body" ref={bodyRef}>
          {visible.length === 0 && <p className="hint">No log entries.</p>}
          {visible.map((e) => (
            <div key={e.seq} className={`log-entry log-${e.dir}`}>
              <span className="log-ts">{e.ts.slice(11, 23)}</span>
              <span className={`log-server log-server-${e.server}`}>{e.server}</span>
              <span className="log-dir">{DIR_SYMBOLS[e.dir] || '?'}</span>
              <span className="log-data">{e.data}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
