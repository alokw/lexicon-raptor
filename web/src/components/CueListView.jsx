import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';
import { cueColorStyles } from '../lib/color.js';
import { hmsfToFrames, framesToHMSF } from '../lib/time.js';

const TRANSPORT_LABELS = { 1: 'PLAY', 2: 'PAUSE', 3: 'STOP' };
const OPERATIONS = {
  play: { label: 'PLAY', className: 'op-play' },
  pause: { label: 'PAUSE', className: 'op-pause' },
  stop: { label: 'STOP', className: 'op-stop' },
  jump: { label: 'JUMP', className: 'op-jump' },
};
const OP_FILTERS = ['play', 'pause', 'jump', 'stop'];

function TimelineRow({ tl, active, isPixeraSelected, onSelect }) {
  return (
    <button className={`tl-row ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="tl-row-top">
        <span className="tl-name" title={tl.name}>
          {tl.name}
        </span>
        <span className={`transport-state mode-${tl.mode || 0}`}>
          {TRANSPORT_LABELS[tl.mode] || '—'}
        </span>
      </div>
      <div className="tl-row-bottom">
        <span className="time">⏱ {tl.timeHMSF || '--:--:--:--'}</span>
        <span className="tl-opacity" title="Timeline opacity">
          ◐ {tl.opacity != null ? `${Math.round(tl.opacity * 100)}%` : '—'}
        </span>
        {isPixeraSelected && (
          <span className="via-tag via-primary" title="Currently selected in Pixera">
            selected
          </span>
        )}
      </div>
    </button>
  );
}

export default function CueListView() {
  const { state, dispatch, toast } = useStore();
  const { timelines, playback } = state;
  const anyConnected = Object.values(state.connections).some((c) => c.status === 'connected');

  const selected =
    state.selectedTimeline && timelines.some((t) => t.name === state.selectedTimeline)
      ? state.selectedTimeline
      : playback.selectedTimelineName || timelines[0]?.name || null;

  const [cueData, setCueData] = useState(null); // {timelineName, fps, cues}
  const [cueError, setCueError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [ops, setOps] = useState({ play: true, pause: true, jump: true, stop: true });
  const [flashKey, setFlashKey] = useState(null); // `${index}` of last-actioned row

  async function loadCues(name) {
    if (!name) return;
    setLoading(true);
    setCueError(null);
    try {
      setCueData(await api.timelineCues(name));
    } catch (err) {
      setCueError(err.message);
      setCueData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCueData(null);
    loadCues(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const tlInfo = timelines.find((t) => t.name === selected) || null;
  const fps = cueData?.fps || tlInfo?.fps || null;
  const nowFrames = tlInfo ? hmsfToFrames(tlInfo.timeHMSF, fps) : null;

  // Cues in timeline order with frame positions and gap-to-next.
  const cues = useMemo(() => {
    const list = (cueData?.cues || [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((c) => ({ ...c, frames: hmsfToFrames(c.time, fps) }));
    return list.map((c, i) => ({
      ...c,
      gapFrames:
        c.frames != null && list[i + 1]?.frames != null ? list[i + 1].frames - c.frames : null,
    }));
  }, [cueData, fps]);

  // Current cue = last cue at/before the playhead; next = the one after.
  let currentIdx = -1;
  if (nowFrames != null) {
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].frames != null && cues[i].frames <= nowFrames) currentIdx = i;
    }
  }
  const nextIdx = currentIdx + 1 < cues.length ? currentIdx + 1 : -1;

  const q = search.trim().toLowerCase();
  const visible = cues.filter((c) => {
    if (c.operation && !ops[c.operation]) return false;
    if (!q) return true;
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.note || '').toLowerCase().includes(q) ||
      String(c.formattedNumber ?? c.number ?? '').toLowerCase().includes(q)
    );
  });

  async function blend(cue, transportMode) {
    const key = `${cue.index}:${transportMode}`;
    setFlashKey(key);
    setTimeout(() => setFlashKey((k) => (k === key ? null : k)), 600);
    try {
      await api.blendToCue({ timelineName: selected, timeHMSF: cue.time, transportMode });
    } catch (err) {
      toast(`Fade to cue failed — ${err.message}`);
    }
  }

  return (
    <>
      <main className="cuelist-main">
        <div className="cuelist-toolbar">
          <div className="cuelist-title" title={selected || ''}>
            {selected || 'No timeline'}
          </div>
          <button
            className="btn btn-sm"
            onClick={() => loadCues(selected)}
            disabled={!selected || loading}
            title="Reload cues from Pixera"
          >
            ↻ Refresh
          </button>
          {OP_FILTERS.map((op) => (
            <label key={op} className={`op-filter ${OPERATIONS[op].className}`}>
              <input
                type="checkbox"
                checked={ops[op]}
                onChange={(e) => setOps({ ...ops, [op]: e.target.checked })}
              />
              {OPERATIONS[op].label}
            </label>
          ))}
          <input
            className="cuelist-search"
            type="search"
            placeholder="Search cues…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="cuelist-scroll">
          {!anyConnected && <p className="hint cuelist-hint">Offline — no Pixera server connected.</p>}
          {anyConnected && cueError && (
            <div className="import-error cuelist-hint">
              <p>Could not read cues: {cueError}</p>
              <button className="btn" onClick={() => loadCues(selected)}>
                Retry
              </button>
            </div>
          )}
          {anyConnected && !cueError && loading && !cueData && (
            <p className="hint cuelist-hint">Loading cues…</p>
          )}
          {anyConnected && !cueError && cueData && cues.length === 0 && (
            <p className="hint cuelist-hint">No cues on this timeline.</p>
          )}

          {cues.length > 0 && (
            <div className="cue-table">
              <div className="cue-row cue-row-head">
                <span />
                <span />
                <span>Type</span>
                <span className="cue-row-actions">Fire</span>
                <span>#</span>
                <span>Name</span>
                <span>Notes</span>
                <span className="num">Time</span>
                <span className="num" title="Time until the next cue on the timeline">
                  → Next
                </span>
              </div>
              {visible.map((cue) => {
                const i = cues.indexOf(cue);
                const colors = cueColorStyles(cue.color);
                const rowClasses = ['cue-row'];
                if (i === currentIdx) rowClasses.push('current');
                if (i === nextIdx) rowClasses.push('upcoming');
                if (colors) rowClasses.push('colored');
                if (flashKey?.startsWith(`${cue.index}:`)) rowClasses.push('flash');
                const op = OPERATIONS[cue.operation];
                return (
                  <div
                    key={`${cue.index}-${cue.name}`}
                    className={rowClasses.join(' ')}
                    style={colors ? { '--cue-accent': colors.accent } : undefined}
                  >
                    <span className="cue-row-stripe" />
                    <span className="cue-row-caret" title={i === currentIdx ? 'Current cue' : i === nextIdx ? 'Next cue' : undefined}>
                      {i === currentIdx ? '▶' : i === nextIdx ? '›' : ''}
                    </span>
                    <span>
                      {op ? <span className={`op-badge ${op.className}`}>{op.label}</span> : '—'}
                    </span>
                    <span className="cue-row-actions">
                      <button
                        className="tbtn tbtn-row"
                        disabled={!cue.time || !anyConnected}
                        title="Fade to this cue and play"
                        onClick={() => blend(cue, 1)}
                      >
                        ▶
                      </button>
                      <button
                        className="tbtn tbtn-row"
                        disabled={!cue.time || !anyConnected}
                        title="Fade to this cue and pause"
                        onClick={() => blend(cue, 2)}
                      >
                        ⏸
                      </button>
                    </span>
                    <span className="cue-row-num">{cue.formattedNumber ?? cue.number ?? '—'}</span>
                    <span className="cue-row-name" title={cue.name || undefined}>
                      {cue.name || <em>(unnamed)</em>}
                    </span>
                    <span className="cue-row-note" title={cue.note || undefined}>
                      {cue.note}
                    </span>
                    <span className="num">{cue.time ?? '—'}</span>
                    <span className="num">
                      {cue.gapFrames != null ? framesToHMSF(cue.gapFrames, fps, { compact: true }) : '—'}
                    </span>
                  </div>
                );
              })}
              {visible.length === 0 && (
                <p className="hint cuelist-hint">No cues match the current filters.</p>
              )}
            </div>
          )}
        </div>
      </main>

      <aside className="cuelist-side">
        <div className="cuelist-side-head">
          <h2>Timelines</h2>
        </div>
        <div className="panel-scroll">
          {timelines.length === 0 && (
            <p className="hint cuelist-hint">
              {anyConnected ? 'Waiting for timeline status…' : 'Offline.'}
            </p>
          )}
          {timelines.map((tl) => (
            <TimelineRow
              key={tl.name}
              tl={tl}
              active={tl.name === selected}
              isPixeraSelected={tl.name === playback.selectedTimelineName}
              onSelect={() => dispatch({ type: 'selectTimeline', name: tl.name })}
            />
          ))}
        </div>
      </aside>
    </>
  );
}
