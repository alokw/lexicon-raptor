import React, { useEffect, useRef, useState } from 'react';
import { useStore } from './lib/store.jsx';
import { api } from './lib/api.js';
import Header from './components/Header.jsx';
import CueGrid from './components/CueGrid.jsx';
import CueListView from './components/CueListView.jsx';
import PropertyPanel from './components/PropertyPanel.jsx';
import ImportModal from './components/ImportModal.jsx';
import DebugModal from './components/DebugModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import FileMgmtModal from './components/FileMgmtModal.jsx';
import Toasts from './components/Toasts.jsx';

export default function App() {
  const { state, toast } = useStore();
  const [showImport, setShowImport] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const anyModal = showImport || showDebug || showSettings || showFiles;

  // Latest state for the (stable) key handler without re-binding every render.
  const ref = useRef({});
  ref.current = { state, anyModal, toast };

  // Space = play/pause toggle on the selected timeline (opt-in via Settings).
  useEffect(() => {
    function onKeyDown(e) {
      if (e.code !== 'Space' || e.repeat || e.defaultPrevented) return;
      const { state, anyModal, toast } = ref.current;
      if (!state.settings?.shortcuts?.keyboardEnabled || anyModal) return;
      const t = e.target;
      if (
        t &&
        (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName) || t.isContentEditable)
      ) {
        return; // don't hijack typing or focused buttons
      }
      e.preventDefault();
      const action = state.playback.transportMode === 1 ? 'pause' : 'play';
      api.transport(action).catch((err) => toast(err.message));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!state.settings) {
    return (
      <div className="loading">
        {state.wsConnected ? 'Loading show…' : 'Connecting to Lexicon Raptor server…'}
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        onOpenDebug={() => setShowDebug(true)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenFiles={() => setShowFiles(true)}
      />
      <div className="workspace">
        {state.view === 'cuelist' ? (
          <CueListView />
        ) : (
          <>
            <CueGrid />
            <PropertyPanel onOpenImport={() => setShowImport(true)} />
          </>
        )}
      </div>
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showDebug && <DebugModal onClose={() => setShowDebug(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showFiles && <FileMgmtModal onClose={() => setShowFiles(false)} />}
      <Toasts />
      {!state.wsConnected && <div className="ws-banner">Server link lost — reconnecting…</div>}
    </div>
  );
}
