import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store.jsx';
import { api } from '../lib/api.js';

function formatSize(bytes) {
  if (bytes == null) return '—';
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function FileMgmtModal({ onClose }) {
  const { toast } = useStore();
  const [shows, setShows] = useState(null);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  async function load() {
    setError(null);
    try {
      const { shows } = await api.listShows();
      setShows(shows);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }

  function createShow() {
    if (!newName.trim()) return;
    run(async () => {
      const { file } = await api.createShow(newName.trim());
      toast(`Created "${file}"`, 'ok');
      setNewName('');
    });
  }

  function activate(show) {
    if (
      !window.confirm(
        `Load "${show.file}"? The dashboard will switch to this show for all connected clients. The current show stays saved.`
      )
    )
      return;
    run(async () => {
      await api.activateShow(show.file);
      toast(`Loaded "${show.file}"`, 'ok');
    });
  }

  function remove(show) {
    if (!window.confirm(`Delete "${show.file}"? This cannot be undone.`)) return;
    run(async () => {
      await api.deleteShow(show.file);
      toast(`Deleted "${show.file}"`, 'ok');
    });
  }

  function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch {
        toast(`"${file.name}" is not valid JSON`);
        return;
      }
      run(async () => {
        const { file: saved } = await api.importShow(file.name, parsed);
        toast(`Imported "${saved}" — use Load to switch to it`, 'ok');
      });
    };
    reader.onerror = () => toast(`Could not read "${file.name}"`);
    reader.readAsText(file);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal files-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Show files</h2>
          <div className="modal-header-actions">
            <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              ⬆ Import file…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={onImportFile}
            />
            <button className="btn" onClick={load} title="Reload the file list">
              ↻ Refresh
            </button>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="files-toolbar">
          <input
            type="text"
            placeholder="New show name…"
            value={newName}
            spellCheck={false}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createShow()}
          />
          <button className="btn" disabled={busy || !newName.trim()} onClick={createShow}>
            + New blank show
          </button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="import-error">
              <p>Could not list show files: {error}</p>
              <button className="btn" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {!error && !shows && <p className="hint">Loading…</p>}
          {shows?.length === 0 && <p className="hint">No show files found.</p>}
          {shows && shows.length > 0 && (
            <table className="files-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Cues</th>
                  <th>Modified</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shows.map((show) => (
                  <tr key={show.file} className={show.active ? 'active-show' : ''}>
                    <td className="files-name">
                      {show.file}
                      {show.active && <span className="active-tag">active</span>}
                      {!show.valid && <span className="warn-tag">invalid JSON</span>}
                    </td>
                    <td>{show.cueCount ?? '—'}</td>
                    <td>{formatDate(show.modifiedAt)}</td>
                    <td>{formatSize(show.size)}</td>
                    <td className="files-actions">
                      {!show.active && (
                        <button
                          className="btn btn-sm"
                          disabled={busy || !show.valid}
                          onClick={() => activate(show)}
                        >
                          Load
                        </button>
                      )}
                      <a
                        className="btn btn-sm"
                        href={api.showDownloadUrl(show.file)}
                        download={show.file}
                        title="Download this show file"
                      >
                        Download
                      </a>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy || show.active}
                        title={show.active ? 'Load another show first' : 'Delete this show file'}
                        onClick={() => remove(show)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="modal-footer">
          <span className="hint">
            Files live in the server's <code>data/</code> folder — they can also be copied in and
            out directly. Hand-edited files are picked up when a show is loaded.
          </span>
        </footer>
      </div>
    </div>
  );
}
