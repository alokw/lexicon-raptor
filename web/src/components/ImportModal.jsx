import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

const keyOf = (timelineName, cueName) => `${timelineName}||${cueName}`;

// Pixera cue operation modes.
const OPERATIONS = {
  1: { label: 'PLAY', className: 'op-play' },
  2: { label: 'PAUSE', className: 'op-pause' },
  3: { label: 'STOP', className: 'op-stop' },
  4: { label: 'JUMP', className: 'op-jump' },
};

export default function ImportModal({ onClose }) {
  const { state, toast } = useStore();
  const [timelines, setTimelines] = useState(null);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [adding, setAdding] = useState(false);

  const existing = useMemo(
    () => new Set(state.cues.map((c) => keyOf(c.timelineName, c.cueName))),
    [state.cues]
  );

  async function load() {
    setTimelines(null);
    setError(null);
    setChecked(new Set());
    try {
      const { timelines } = await api.listImportCues();
      setTimelines(timelines);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggle(key) {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  /** Select every importable cue, optionally filtered by operation mode. */
  function selectAll(operation) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const tl of timelines || []) {
        for (const cue of tl.cues) {
          if (operation != null && cue.operation !== operation) continue;
          const key = keyOf(tl.timelineName, cue.name);
          if (!existing.has(key)) next.add(key);
        }
      }
      return next;
    });
  }

  async function addSelected() {
    if (checked.size === 0) return;
    setAdding(true);
    let added = 0;
    try {
      for (const tl of timelines) {
        for (const cue of tl.cues) {
          const key = keyOf(tl.timelineName, cue.name);
          if (!checked.has(key)) continue;
          await api.addCue({
            label: cue.name,
            cueName: cue.name,
            timelineName: tl.timelineName,
            fadeMs: '',
            notes: cue.note || '',
          });
          added++;
        }
      }
      toast(`Added ${added} cue${added === 1 ? '' : 's'} to the cuelist`, 'ok');
      onClose();
    } catch (err) {
      toast(`Import stopped after ${added} cues — ${err.message}`);
      setAdding(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Import cues from Pixera</h2>
          <div className="modal-header-actions">
            <button className="btn" onClick={load} title="Reload cues from Pixera">
              ↻ Refresh
            </button>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {timelines && !error && (
          <div className="import-toolbar">
            <span className="field-label">Select:</span>
            <button className="btn btn-sm" disabled={adding} onClick={() => selectAll(null)}>
              All
            </button>
            <button className="btn btn-sm" disabled={adding} onClick={() => selectAll(1)}>
              All Play
            </button>
            <button className="btn btn-sm" disabled={adding} onClick={() => selectAll(2)}>
              All Pause
            </button>
            <button
              className="btn btn-sm"
              disabled={adding || checked.size === 0}
              onClick={() => setChecked(new Set())}
            >
              None
            </button>
          </div>
        )}

        <div className="modal-body">
          {error && (
            <div className="import-error">
              <p>Could not read cues: {error}</p>
              <button className="btn" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {!error && !timelines && <p className="hint">Loading cues from Pixera…</p>}
          {timelines?.length === 0 && <p className="hint">No timelines found in the project.</p>}
          {timelines?.map((tl) => (
            <section key={tl.timelineName} className="import-timeline">
              <h3>{tl.timelineName}</h3>
              {tl.error && <p className="hint">Error: {tl.error}</p>}
              {tl.cues.length === 0 && !tl.error && <p className="hint">No cues.</p>}
              <ul className="import-cue-list">
                {tl.cues.map((cue) => {
                  const key = keyOf(tl.timelineName, cue.name);
                  const exists = existing.has(key);
                  return (
                    <li key={key} className={exists ? 'exists' : ''}>
                      <label>
                        <input
                          type="checkbox"
                          disabled={exists || adding}
                          checked={exists || checked.has(key)}
                          onChange={() => toggle(key)}
                        />
                        <span className="import-cue-name">{cue.name}</span>
                        {cue.numberFormatted != null && (
                          <span className="import-cue-number">#{cue.numberFormatted}</span>
                        )}
                        {OPERATIONS[cue.operation] && (
                          <span className={`op-badge ${OPERATIONS[cue.operation].className}`}>
                            {OPERATIONS[cue.operation].label}
                          </span>
                        )}
                        {exists && <span className="import-exists-tag">in cuelist</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <footer className="modal-footer">
          <span className="hint">
            {checked.size} selected · cues already in the cuelist are greyed out
          </span>
          <button
            className="btn btn-primary"
            disabled={checked.size === 0 || adding}
            onClick={addSelected}
          >
            {adding ? 'Adding…' : 'Add to cuelist'}
          </button>
        </footer>
      </div>
    </div>
  );
}
