import React, { useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

// Per zoom level (1..6): tile min-width, label font size, meta font size.
const ZOOM_LEVELS = [
  { tile: 120, label: 12, meta: 9 },
  { tile: 150, label: 14, meta: 10 },
  { tile: 190, label: 17, meta: 11 },
  { tile: 240, label: 22, meta: 12 },
  { tile: 300, label: 28, meta: 13 },
  { tile: 380, label: 34, meta: 14 },
];
const DRAG_THRESHOLD_PX = 8;

export default function CueGrid() {
  const { state, dispatch, toast } = useStore();
  const { cues, mode, selectedCueId, zoom } = state;
  const isEdit = mode === 'edit';

  const [previewOrder, setPreviewOrder] = useState(null); // ids during drag
  const [draggingId, setDraggingId] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const dragRef = useRef(null);

  const orderedCues = previewOrder
    ? previewOrder.map((id) => cues.find((c) => c.id === id)).filter(Boolean)
    : cues;

  async function fireCue(cue) {
    dispatch({ type: 'firedCue', id: cue.id });
    setFlashId(cue.id);
    setTimeout(() => setFlashId((f) => (f === cue.id ? null : f)), 600);
    try {
      await api.fireCue(cue.id);
    } catch (err) {
      toast(`GO failed — ${err.message}`);
    }
  }

  function onTilePointerDown(e, cue) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('.tile-delete')) return;

    if (!isEdit) {
      // Run mode: fire immediately on press (fast for live operation).
      fireCue(cue);
      return;
    }

    dispatch({ type: 'selectCue', id: cue.id });
    dragRef.current = {
      id: cue.id,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      order: cues.map((c) => c.id),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onTilePointerMove(e) {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.active) {
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (dist < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      setDraggingId(drag.id);
      setPreviewOrder(drag.order);
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overTile = el?.closest?.('[data-cue-id]');
    const overId = overTile?.dataset.cueId;
    if (!overId || overId === drag.id) return;

    const order = [...drag.order];
    const from = order.indexOf(drag.id);
    const to = order.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, drag.id);
    drag.order = order;
    setPreviewOrder(order);
  }

  async function onTilePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !drag.active) return;
    setDraggingId(null);
    const original = cues.map((c) => c.id);
    const changed = drag.order.some((id, i) => id !== original[i]);
    if (changed) {
      try {
        await api.reorderCues(drag.order);
      } catch (err) {
        toast(`Reorder failed — ${err.message}`);
      }
    }
    setPreviewOrder(null);
  }

  async function deleteCue(cue) {
    if (!window.confirm(`Delete cue "${cue.label || cue.cueName}"?`)) return;
    try {
      await api.deleteCue(cue.id);
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <main
      className={`cue-grid-wrap ${isEdit ? 'edit-mode' : 'run-mode'}`}
      style={{
        '--tile-min': `${ZOOM_LEVELS[zoom - 1].tile}px`,
        '--tile-font': `${ZOOM_LEVELS[zoom - 1].label}px`,
        '--tile-meta-font': `${ZOOM_LEVELS[zoom - 1].meta}px`,
      }}
    >
      {orderedCues.length === 0 && (
        <div className="empty-state">
          <p>No cues yet.</p>
          <p className="hint">
            Add cues from the panel on the right, or use <strong>Import</strong> to pull cues from
            Pixera.
          </p>
        </div>
      )}
      <div className="cue-grid">
        {orderedCues.map((cue) => {
          const classes = ['cue-tile'];
          if (cue.id === selectedCueId) classes.push('selected');
          if (cue.id === draggingId) classes.push('dragging');
          if (cue.id === flashId) classes.push('fired');
          return (
            <div
              key={cue.id}
              data-cue-id={cue.id}
              className={classes.join(' ')}
              onPointerDown={(e) => onTilePointerDown(e, cue)}
              onPointerMove={onTilePointerMove}
              onPointerUp={onTilePointerUp}
              onPointerCancel={onTilePointerUp}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  isEdit ? dispatch({ type: 'selectCue', id: cue.id }) : fireCue(cue);
                }
              }}
            >
              {isEdit && (
                <button
                  className="tile-delete"
                  title="Delete cue"
                  onClick={() => deleteCue(cue)}
                >
                  ×
                </button>
              )}
              <div className="tile-label">{cue.label || cue.cueName}</div>
              <div className="tile-meta">
                <span className="tile-cue-name">{cue.cueName}</span>
                <span className="tile-timeline">
                  {cue.timelineName || '(selected timeline)'}
                </span>
                {cue.notes && <span className="tile-notes">{cue.notes}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
