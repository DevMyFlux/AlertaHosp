import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from './ui';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao entrar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-surface p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-unit text-sm font-bold text-[color:var(--unit-ink)]" aria-hidden>E</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Monitor de Energia</h1>
            <p className="text-xs text-ink-3">Acesso restrito à equipe</p>
          </div>
        </div>
        <label htmlFor="senha" className="mb-1 block text-xs font-medium text-ink-2">Senha de acesso</label>
        <input id="senha" type="password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-[color:var(--unit)]" />
        {error && <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--crit)' }}>{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !password} className="mt-4 w-full justify-center">{busy ? 'Entrando…' : 'Entrar'}</Button>
      </form>
    </div>
  );
}
