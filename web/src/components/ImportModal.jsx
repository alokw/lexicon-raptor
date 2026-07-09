import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

// Cues are identified by timeline + cue name (that's also how they're fired).
const keyOf = (timelineName, cueName) => `${timelineName}||${cueName}`;

// Cue operation modes (normalized server-side to lowercase strings).
const OPERATIONS = {
  play: { label: 'PLAY', className: 'op-play' },
  pause: { label: 'PAUSE', className: 'op-pause' },
  stop: { label: 'STOP', className: 'op-stop' },
  jump: { label: 'JUMP', className: 'op-jump' },
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

  // Duplicate cue names within a timeline can't be distinguished when firing
  // by name (Pixera triggers the first match) — flag them for the operator.
  const duplicateKeys = useMemo(() => {
    const seen = new Set();
    const dups = new Set();
    for (const tl of timelines || []) {
      for (const cue of tl.cues) {
        if (!cue.name) continue;
        const key = keyOf(tl.timelineName, cue.name);
        if (seen.has(key)) dups.add(key);
        seen.add(key);
      }
    }
    return dups;
  }, [timelines]);

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
          if (!cue.name) continue; // unnamed cues can't be fired by name
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
    const done = new Set(); // guard: duplicate names share a key — add once
    try {
      for (const tl of timelines) {
        for (const cue of tl.cues) {
          if (!cue.name) continue;
          const key = keyOf(tl.timelineName, cue.name);
          if (!checked.has(key) || done.has(key)) continue;
          done.add(key);
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
            <button className="btn btn-sm" disabled={adding} onClick={() => selectAll('play')}>
              All Play
            </button>
            <button className="btn btn-sm" disabled={adding} onClick={() => selectAll('pause')}>
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
                {tl.cues.map((cue, i) => {
                  const key = keyOf(tl.timelineName, cue.name);
                  const unnamed = !cue.name;
                  const exists = !unnamed && existing.has(key);
                  const disabled = unnamed || exists || adding;
                  return (
                    <li key={`${key}#${cue.index ?? i}`} className={disabled ? 'exists' : ''}>
                      <label
                        title={
                          unnamed
                            ? 'This cue has no name in Pixera, so it cannot be fired by name. Name it in Pixera first.'
                            : duplicateKeys.has(key)
                              ? 'Several cues share this name — firing by name triggers the first one on the timeline.'
                              : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={exists || checked.has(key)}
                          onChange={() => toggle(key)}
                        />
                        <span className="import-cue-name">
                          {unnamed ? '(unnamed)' : cue.name}
                        </span>
                        {cue.time && <span className="import-cue-number">{cue.time}</span>}
                        {OPERATIONS[cue.operation] && (
                          <span className={`op-badge ${OPERATIONS[cue.operation].className}`}>
                            {OPERATIONS[cue.operation].label}
                          </span>
                        )}
                        {unnamed && <span className="warn-tag">no name</span>}
                        {!unnamed && duplicateKeys.has(key) && (
                          <span className="warn-tag">duplicate</span>
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
            {checked.size} selected · greyed cues are already in the cuelist or unnamed
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
