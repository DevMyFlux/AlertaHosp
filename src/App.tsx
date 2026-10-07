import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { Login } from './components/Login';
import { ErrorBox, Skeleton } from './components/ui';
import { api, ApiError } from './lib/api';
import { useRemote } from './lib/hooks';
import { useRoute } from './lib/router';
import { useTheme, useUnitAccent } from './lib/theme';
import type { AuthState } from './lib/types';
import { OverviewPage } from './pages/OverviewPage';

// Páginas pesadas (gráficos/gaveta) carregadas sob demanda
const SectorsPage = lazy(() => import('./pages/SectorsPage').then(m => ({ default: m.SectorsPage })));
const AlertsPage = lazy(() => import('./pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));

export default function App() {
  const route = useRoute();
  const theme = useTheme();
  useUnitAccent(route.unit, theme.resolved);

  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const loadAuth = useCallback(() => {
    api.auth.me().then(setAuth).catch(e => setAuthError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))));
  }, []);
  useEffect(loadAuth, [loadAuth]);

  const units = useRemote(signal => (auth && (!auth.authRequired || auth.authenticated) ? api.units(signal) : Promise.resolve({ units: [] })), [auth?.authenticated, auth?.authRequired]);
  const info = units.data?.units.find(u => u.code === route.unit);

  if (authError) return <div className="mx-auto max-w-xl p-8"><ErrorBox error={authError} onRetry={() => { setAuthError(null); loadAuth(); }} /></div>;
  if (!auth) return <div className="mx-auto max-w-5xl p-8"><Skeleton className="h-40" /></div>;
  if (auth.authRequired && !auth.authenticated) return <Login onDone={loadAuth} />;

  return (
    <div className="min-h-full">
      <Header route={route} intervalMin={info?.intervalMin ?? 15} theme={theme.choice} onTheme={theme.setChoice}
        canLogout={auth.authRequired} onLogout={() => api.auth.logout().then(loadAuth)} />
      {/* key=unidade: trocar de hospital remonta a página — nenhum estado do hospital anterior sobrevive */}
      <main key={route.unit} className="mx-auto max-w-[1320px] px-5 py-6">
        <Suspense fallback={<Skeleton className="h-64" />}>
          {route.page === 'overview' && <OverviewPage unit={route.unit} />}
          {route.page === 'sectors' && <SectorsPage unit={route.unit} selected={route.sector} intervalMin={info?.intervalMin ?? 15} />}
          {route.page === 'alerts' && <AlertsPage unit={route.unit} selectedId={route.alertId} info={info} />}
          {route.page === 'settings' && <SettingsPage unit={route.unit} theme={theme.choice} onTheme={theme.setChoice} auth={auth} />}
        </Suspense>
      </main>
    </div>
  );
}
