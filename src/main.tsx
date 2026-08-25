import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
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

// HARD RESET: Forçando a limpeza total dos dados de alertas antigos do navegador 
// na inicialização do aplicativo (equivalente a um TRUNCATE da tabela local).
try {
  localStorage.removeItem('alert_log');
  console.log("HARD RESET: Tabela de alertas locais (alert_log) foi esvaziada com sucesso.");
} catch (e) {
  // Ignora erros
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
