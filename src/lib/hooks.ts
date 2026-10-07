import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Remote<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** recarrega mantendo os dados atuais na tela */
  reload: () => void;
}

/**
 * Carrega dados da API cancelando a requisição anterior quando os parâmetros mudam.
 * Trocar de unidade ou de filtro descarta os dados antigos (a resposta do hospital
 * anterior nunca "vaza" na tela); recarregar/atualizar em segundo plano os mantém.
 * `refreshMs` repete a busca periodicamente.
 */
export function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], refreshMs?: number): Remote<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = JSON.stringify(deps);
  const keyRef = useRef(key);

  useEffect(() => {
    const controller = new AbortController();
    const changed = keyRef.current !== key;
    keyRef.current = key;
    setState(s => ({ data: changed ? null : s.data, error: null, loading: true }));
    loadRef
      .current(controller.signal)
      .then(data => setState({ data, error: null, loading: false }))
      .catch(error => {
        if ((error as Error).name === 'AbortError') return;
        setState(s => ({ data: s.data, error: error instanceof ApiError ? error : new ApiError(0, 'error', String(error)), loading: false }));
      });
    return () => controller.abort();
  }, [key, tick]);

  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => setTick(t => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const reload = useCallback(() => setTick(t => t + 1), []);
  return { ...state, reload };
}
