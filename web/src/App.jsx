import React, { useState } from 'react';
import { useStore } from './lib/store.jsx';
import Header from './components/Header.jsx';
import CueGrid from './components/CueGrid.jsx';
import PropertyPanel from './components/PropertyPanel.jsx';
import ImportModal from './components/ImportModal.jsx';
import DebugModal from './components/DebugModal.jsx';
import Toasts from './components/Toasts.jsx';

export default function App() {
  const { state } = useStore();
  const [showImport, setShowImport] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  if (!state.settings) {
    return (
      <div className="loading">
        {state.wsConnected ? 'Loading show…' : 'Connecting to Lexicon Raptor server…'}
      </div>
    );
  }

  return (
    <div className="app">
      <Header onOpenDebug={() => setShowDebug(true)} />
      <div className="workspace">
        <CueGrid />
        <PropertyPanel onOpenImport={() => setShowImport(true)} />
      </div>
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
      {showDebug && <DebugModal onClose={() => setShowDebug(false)} />}
      <Toasts />
      {!state.wsConnected && <div className="ws-banner">Server link lost — reconnecting…</div>}
    </div>
  );
}
