import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

const EMPTY_FORM = { label: '', cueName: '', timelineName: '', fadeMs: '', notes: '', color: '' };

function CueForm({ initial, disabled, submitLabel, onSubmit, onDelete }) {
  const { state } = useStore();
  const [form, setForm] = useState(initial || EMPTY_FORM);
  // Reset only when the *values* change (parent re-renders every playback
  // tick with a fresh `initial` object; comparing by reference would wipe
  // in-progress edits while a timeline is playing).
  const initialJson = JSON.stringify(initial ?? null);
  useEffect(() => {
    setForm(initial || EMPTY_FORM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJson]);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <form
      className="cue-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form, () => setForm(EMPTY_FORM));
      }}
    >
      <label className="field">
        <span>Label</span>
        <input value={form.label} onChange={set('label')} disabled={disabled} placeholder="Big button text" />
      </label>
      <label className="field">
        <span>Cue name *</span>
        <input value={form.cueName} onChange={set('cueName')} disabled={disabled} placeholder="As named in Pixera" required />
      </label>
      <label className="field">
        <span>Timeline name</span>
        <input value={form.timelineName} onChange={set('timelineName')} disabled={disabled} placeholder="blank = selected timeline" />
        <small>Blank uses the timeline currently selected in Pixera.</small>
      </label>
      <label className="field">
        <span>Fade time (ms)</span>
        <input
          type="number"
          min="0"
          step="100"
          value={form.fadeMs ?? ''}
          onChange={set('fadeMs')}
          disabled={disabled}
          placeholder={`blank = default (${state.settings.defaultFadeMs} ms)`}
        />
        <small>Blank uses the default fade time from the header.</small>
      </label>
      <label className="field">
        <span>Notes</span>
        <textarea rows="2" value={form.notes} onChange={set('notes')} disabled={disabled} />
      </label>
      <div className="field">
        <span>Color</span>
        <div className="color-field">
          <input
            type="color"
            value={form.color || '#4c8dff'}
            onChange={set('color')}
            disabled={disabled}
            title="Cue color (shown darkened on the tile)"
          />
          {form.color ? (
            !disabled && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setForm({ ...form, color: '' })}
              >
                Clear
              </button>
            )
          ) : (
            <small>no color</small>
          )}
        </div>
      </div>
      {!disabled && (
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {submitLabel}
          </button>
          {onDelete && (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      )}
    </form>
  );
}

/**
 * Bulk edit for a ctrl/cmd-click multi-selection. Each field only applies
 * when its checkbox is ticked, so "blank" and "leave unchanged" stay distinct.
 */
function BulkEditPanel({ ids }) {
  const { state, dispatch, toast } = useStore();
  const [apply, setApply] = useState({ timelineName: false, fadeMs: false, notes: false, color: false });
  const [form, setForm] = useState({ timelineName: '', fadeMs: '', notes: '', color: '' });
  const [busy, setBusy] = useState(false);

  const field = (key, input) => (
    <label className={`field bulk-field ${apply[key] ? '' : 'bulk-off'}`}>
      <span>
        <input
          type="checkbox"
          checked={apply[key]}
          onChange={(e) => setApply({ ...apply, [key]: e.target.checked })}
        />{' '}
        {{ timelineName: 'Timeline name', fadeMs: 'Fade time (ms)', notes: 'Notes', color: 'Color' }[key]}
      </span>
      {input}
    </label>
  );

  async function applyAll() {
    const patch = {};
    for (const key of Object.keys(apply)) if (apply[key]) patch[key] = form[key];
    if (Object.keys(patch).length === 0) {
      toast('Tick at least one field to apply');
      return;
    }
    if (!window.confirm(`Are you sure you want to edit all ${ids.length} cues selected?`)) return;
    setBusy(true);
    let done = 0;
    try {
      for (const id of ids) {
        await api.updateCue(id, patch);
        done++;
      }
      toast(`Updated ${done} cues`, 'ok');
    } catch (err) {
      toast(`Bulk edit stopped after ${done} cues — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (!window.confirm(`Delete all ${ids.length} selected cues? This cannot be undone.`)) return;
    setBusy(true);
    let done = 0;
    try {
      for (const id of ids) {
        await api.deleteCue(id);
        done++;
      }
      toast(`Deleted ${done} cues`, 'ok');
      dispatch({ type: 'clearCueSelection' });
    } catch (err) {
      toast(`Bulk delete stopped after ${done} cues — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cue-form">
      <p className="hint">
        Tick a field to apply it to every selected cue; unticked fields keep their per-cue values.
      </p>
      {field(
        'timelineName',
        <input
          value={form.timelineName}
          disabled={!apply.timelineName}
          placeholder="blank = selected timeline"
          onChange={(e) => setForm({ ...form, timelineName: e.target.value })}
        />
      )}
      {field(
        'fadeMs',
        <input
          type="number"
          min="0"
          step="100"
          value={form.fadeMs}
          disabled={!apply.fadeMs}
          placeholder={`blank = default (${state.settings.defaultFadeMs} ms)`}
          onChange={(e) => setForm({ ...form, fadeMs: e.target.value })}
        />
      )}
      {field(
        'notes',
        <textarea
          rows="2"
          value={form.notes}
          disabled={!apply.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      )}
      {field(
        'color',
        <div className="color-field">
          <input
            type="color"
            value={form.color || '#4c8dff'}
            disabled={!apply.color}
            onChange={(e) => setForm({ ...form, color: e.target.value })}
          />
          {apply.color && form.color && (
            <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, color: '' })}>
              Clear
            </button>
          )}
          {apply.color && !form.color && <small>clears the color</small>}
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={applyAll}>
          Apply to {ids.length} cues
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={deleteAll}>
          Delete {ids.length}
        </button>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => dispatch({ type: 'clearCueSelection' })}
      >
        Clear selection
      </button>
    </div>
  );
}

export default function PropertyPanel({ onOpenImport }) {
  const { state, dispatch, toast } = useStore();
  const { mode, cues, selectedCueId, selectedCueIds, zoom } = state;
  const isEdit = mode === 'edit';
  const selectedCue = cues.find((c) => c.id === selectedCueId) || null;
  const multiSelect = isEdit && selectedCueIds.length > 1;

  async function addCue(form, reset) {
    try {
      await api.addCue(form);
      reset();
    } catch (err) {
      toast(err.message);
    }
  }

  async function saveCue(form) {
    try {
      await api.updateCue(selectedCue.id, form);
      toast('Cue updated', 'ok');
    } catch (err) {
      toast(err.message);
    }
  }

  async function deleteCue() {
    if (!window.confirm(`Delete cue "${selectedCue.label || selectedCue.cueName}"?`)) return;
    try {
      await api.deleteCue(selectedCue.id);
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <aside className="property-panel">
      <div className="mode-toggle" role="tablist">
        <button
          role="tab"
          className={isEdit ? '' : 'active'}
          onClick={() => dispatch({ type: 'setMode', mode: 'run' })}
        >
          Run
        </button>
        <button
          role="tab"
          className={isEdit ? 'active' : ''}
          onClick={() => dispatch({ type: 'setMode', mode: 'edit' })}
        >
          Edit
        </button>
      </div>

      <div className="panel-scroll">
        {isEdit && (
          <section className="panel-section">
            <h2>Add cue</h2>
            <CueForm submitLabel="Add" onSubmit={addCue} />
          </section>
        )}

        <section className="panel-section grow">
          <h2>
            {multiSelect
              ? `${selectedCueIds.length} cues selected`
              : isEdit
                ? 'Selected cue'
                : 'Last cue'}
          </h2>
          {multiSelect ? (
            <BulkEditPanel ids={selectedCueIds} />
          ) : selectedCue ? (
            <CueForm
              key={selectedCue.id}
              initial={{
                label: selectedCue.label,
                cueName: selectedCue.cueName,
                timelineName: selectedCue.timelineName,
                fadeMs: selectedCue.fadeMs ?? '',
                notes: selectedCue.notes,
                color: selectedCue.color ?? '',
              }}
              disabled={!isEdit}
              submitLabel="Save"
              onSubmit={saveCue}
              onDelete={deleteCue}
            />
          ) : (
            <p className="hint">
              {isEdit
                ? 'Click a cue to edit it. Ctrl/Cmd-click to select several for bulk edit or delete.'
                : 'Fire a cue to see its properties.'}
            </p>
          )}
        </section>
      </div>

      <section className="panel-section panel-footer">
        <button className="btn btn-wide" onClick={onOpenImport}>
          Import from Pixera…
        </button>
        <div className="zoom-controls">
          <span className="field-label">Cue size</span>
          <button
            className="btn"
            title="Smaller cue buttons"
            disabled={zoom <= 1}
            onClick={() => dispatch({ type: 'setZoom', zoom: zoom - 1 })}
          >
            −
          </button>
          <span className="zoom-level">{zoom}</span>
          <button
            className="btn"
            title="Larger cue buttons"
            disabled={zoom >= 6}
            onClick={() => dispatch({ type: 'setZoom', zoom: zoom + 1 })}
          >
            +
          </button>
        </div>
      </section>
    </aside>
  );
}
