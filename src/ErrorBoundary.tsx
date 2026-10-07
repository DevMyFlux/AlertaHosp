import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Falha de renderização vira uma tela útil (e o erro real vai para o console), em vez de tela em branco. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro de renderização:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-6 text-center">
        <h1 className="text-base font-semibold">Algo deu errado ao montar esta tela</h1>
        <p className="mt-1 text-[13px] text-ink-3">Os dados não foram afetados. Recarregue a página; se persistir, avise o suporte.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium hover:bg-surface-2">
          Recarregar
        </button>
      </div>
    );
  }
}
