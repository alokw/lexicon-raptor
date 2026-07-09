import React from 'react';
import { useStore } from '../lib/store.jsx';

export default function Toasts() {
  const { state, dispatch } = useStore();
  if (state.toasts.length === 0) return null;
  return (
    <div className="toasts">
      {state.toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => dispatch({ type: 'dismissToast', id: t.id })}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
