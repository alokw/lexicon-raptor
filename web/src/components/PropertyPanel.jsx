import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

const EMPTY_FORM = { label: '', cueName: '', timelineName: '', fadeMs: '', notes: '' };

function CueForm({ initial, disabled, submitLabel, onSubmit, onDelete }) {
  const { state } = useStore();
  const [form, setForm] = useState(initial || EMPTY_FORM);
  useEffect(() => setForm(initial || EMPTY_FORM), [initial]);

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

export default function PropertyPanel({ onOpenImport }) {
  const { state, dispatch, toast } = useStore();
  const { mode, cues, selectedCueId, zoom } = state;
  const isEdit = mode === 'edit';
  const selectedCue = cues.find((c) => c.id === selectedCueId) || null;

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
          <h2>{isEdit ? 'Selected cue' : 'Last cue'}</h2>
            {selectedCue ? (
            <CueForm
              key={selectedCue.id}
              initial={{
                label: selectedCue.label,
                cueName: selectedCue.cueName,
                timelineName: selectedCue.timelineName,
                fadeMs: selectedCue.fadeMs ?? '',
                notes: selectedCue.notes,
              }}
              disabled={!isEdit}
              submitLabel="Save"
              onSubmit={saveCue}
              onDelete={deleteCue}
            />
          ) : (
            <p className="hint">
              {isEdit ? 'Click a cue in the list to edit it.' : 'Fire a cue to see its properties.'}
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
