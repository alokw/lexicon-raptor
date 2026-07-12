/**
 * App-wide store: server-pushed state (settings, cues, connections, playback,
 * comms log) over WebSocket with auto-reconnect, plus client-only UI state
 * (mode, selection, zoom, toasts).
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useCallback,
} from 'react';

const MAX_LOG_ENTRIES = 2000;

const initialState = {
  wsConnected: false,
  settings: null,
  cues: [],
  connections: {},
  playback: {
    selectedTimelineName: null,
    transportMode: null,
    currentHMSF: null,
    countdownHMSF: null,
    nextCueName: null,
    nextCueNumber: null,
    source: null,
  },
  log: [],
  timelines: [], // all-timelines status (Cue List view), pushed by the server
  activeShow: null,
  // client-only UI state
  view: localStorage.getItem('lr.view') === 'cuelist' ? 'cuelist' : 'shortcuts',
  mode: 'run', // 'run' | 'edit'
  selectedCueId: null,
  selectedCueIds: [], // edit-mode multi-select (ctrl/cmd-click)
  lastFiredCueId: null,
  selectedTimeline: null, // Cue List view
  zoom: Number(localStorage.getItem('lr.zoom')) || 3, // tiles per ~row step, 1..6
  toasts: [],
};

function reducer(state, action) {
  switch (action.type) {
    case 'ws': {
      return { ...state, wsConnected: action.connected };
    }
    case 'state': {
      const { settings, cues, connections, playback, timelines, activeShow } = action.msg;
      const next = { ...state, settings, cues, connections, playback };
      if (timelines) next.timelines = timelines;
      if (activeShow !== undefined) next.activeShow = activeShow;
      if (state.selectedCueId && !cues.some((c) => c.id === state.selectedCueId)) {
        next.selectedCueId = null;
      }
      next.selectedCueIds = state.selectedCueIds.filter((id) => cues.some((c) => c.id === id));
      return next;
    }
    case 'playback':
      return { ...state, playback: action.msg.playback };
    case 'connections':
      return { ...state, connections: action.msg.connections };
    case 'logHistory':
      return { ...state, log: action.msg.entries };
    case 'log': {
      const log = [...state.log, action.msg.entry];
      if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
      return { ...state, log };
    }
    case 'timelines':
      return { ...state, timelines: action.msg.timelines };
    case 'setView': {
      localStorage.setItem('lr.view', action.view);
      return { ...state, view: action.view };
    }
    case 'setMode':
      return { ...state, mode: action.mode };
    case 'selectCue': {
      if (action.multi) {
        const ids = state.selectedCueIds.includes(action.id)
          ? state.selectedCueIds.filter((x) => x !== action.id)
          : [...state.selectedCueIds, action.id];
        return { ...state, selectedCueIds: ids, selectedCueId: ids[ids.length - 1] ?? null };
      }
      return { ...state, selectedCueIds: [action.id], selectedCueId: action.id };
    }
    case 'clearCueSelection':
      return { ...state, selectedCueIds: [], selectedCueId: null };
    case 'selectTimeline':
      return { ...state, selectedTimeline: action.name };
    case 'firedCue':
      return { ...state, lastFiredCueId: action.id, selectedCueId: action.id, selectedCueIds: [action.id] };
    case 'setZoom': {
      const zoom = Math.min(6, Math.max(1, action.zoom));
      localStorage.setItem('lr.zoom', String(zoom));
      return { ...state, zoom };
    }
    case 'toast': {
      return { ...state, toasts: [...state.toasts, action.toast] };
    }
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const toastSeq = useRef(1);

  const toast = useCallback((message, kind = 'error') => {
    const id = toastSeq.current++;
    dispatch({ type: 'toast', toast: { id, message, kind } });
    setTimeout(() => dispatch({ type: 'dismissToast', id }), kind === 'error' ? 6000 : 3000);
  }, []);

  useEffect(() => {
    let ws = null;
    let closed = false;
    let retryTimer = null;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => dispatch({ type: 'ws', connected: true });
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type) dispatch({ type: msg.type, msg });
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        dispatch({ type: 'ws', connected: false });
        if (!closed) retryTimer = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      if (ws) ws.close();
    };
  }, []);

  return (
    <StoreContext.Provider value={{ state, dispatch, toast }}>{children}</StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
