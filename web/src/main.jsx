import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './lib/store.jsx';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>
);
