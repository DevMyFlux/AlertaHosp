import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { HospitalProvider } from './config/HospitalContext.tsx';
import './index.css';

window.addEventListener('error', e => {
  if (e.message === 'Script error.' || (e.message && e.message.includes('ResizeObserver'))) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true); // use capture phase

window.addEventListener('unhandledrejection', e => {
  if (e.reason && e.reason.message === 'Script error.') {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('ResizeObserver') || args[0] === 'Script error.')) return;
  originalError(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HospitalProvider>
        <App />
      </HospitalProvider>
    </ErrorBoundary>
  </StrictMode>,
);
