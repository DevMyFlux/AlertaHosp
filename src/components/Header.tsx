import { LogOut, Moon, Sun, SunMoon } from 'lucide-react';
import { UNIT_CODES, UNIT_META, type UnitCode } from '../../core/unitMeta';
import { api } from '../lib/api';
import { ago, timeOnly } from '../lib/format';
import { useRemote } from '../lib/hooks';
import { href, type PageKey, type Route } from '../lib/router';
import type { ThemeChoice } from '../lib/theme';
import { cx } from './ui';

const NAV: { page: PageKey; label: string }[] = [
  { page: 'overview', label: 'Visão geral' },
  { page: 'sectors', label: 'Setores' },
  { page: 'alerts', label: 'Alertas' },
  { page: 'settings', label: 'Configurações' },
];

/** Seletor HCN | HMB — sempre visível; troca de unidade mantendo a mesma página. */
function UnitSwitcher({ route }: { route: Route }) {
  return (
    <div role="group" aria-label="Unidade" className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
      {UNIT_CODES.map(code => {
        const active = code === route.unit;
        return (
          <a
            key={code}
            href={href(code, route.page)}
            aria-current={active ? 'page' : undefined}
            className={cx('flex items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-semibold tracking-wide no-underline transition-colors', active ? 'text-[color:var(--unit-ink)]' : 'text-ink-2 hover:bg-surface-2')}
            style={active ? { background: 'var(--unit)' } : undefined}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: active ? 'var(--unit-ink)' : UNIT_META[code].accent }} />
            {code}
          </a>
        );
      })}
    </div>
  );
}

/** Frescor dos dados da unidade atual (vem do /api/health). */
function FreshnessChip({ unit, intervalMin }: { unit: UnitCode; intervalMin: number }) {
  const health = useRemote(signal => fetch('/api/health', { signal }).then(r => r.json()) as Promise<{ database: string; units: { code: string; ageMinutes: number | null; lastReadingTs: string | null; sourceStatus: string }[] }>, [], 60_000);
  const u = health.data?.units.find(x => x.code === unit);
  let tone = 'var(--ink-3)';
  let text = 'verificando dados…';
  if (health.data) {
    if (health.data.database !== 'ok') {
      tone = 'var(--crit)';
      text = 'banco de dados indisponível';
    } else if (!u || u.ageMinutes === null) {
      tone = 'var(--warn)';
      text = 'sem leituras ainda';
    } else {
      tone = u.ageMinutes <= intervalMin * 2.2 ? 'var(--ok)' : u.ageMinutes <= intervalMin * 4 ? 'var(--warn)' : 'var(--crit)';
      text = `Dados das ${timeOnly(u.lastReadingTs)} · ${ago(u.ageMinutes)}`;
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs text-ink-2" title="Última leitura recebida da fonte de telemetria desta unidade">
      <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
      <span className="num">{text}</span>
    </div>
  );
}

export function Header({
  route, intervalMin, theme, onTheme, canLogout, onLogout,
}: { route: Route; intervalMin: number; theme: ThemeChoice; onTheme: (t: ThemeChoice) => void; canLogout: boolean; onLogout: () => void }) {
  const next: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="h-[3px] w-full" style={{ background: 'var(--unit)' }} aria-hidden />
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-md text-xs font-bold" style={{ background: 'var(--unit)', color: 'var(--unit-ink)' }} aria-hidden>
            E
          </div>
          <span className="text-[15px] font-semibold tracking-tight">Monitor de Energia</span>
        </div>
        <UnitSwitcher route={route} />
        <nav aria-label="Principal" className="flex items-center gap-1">
          {NAV.map(n => {
            const active = n.page === route.page;
            return (
              <a key={n.page} href={href(route.unit, n.page)} aria-current={active ? 'page' : undefined}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors', active ? 'bg-unit-soft text-unit' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <FreshnessChip unit={route.unit} intervalMin={intervalMin} />
          <button type="button" onClick={() => onTheme(next[theme])} className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2" title={`Tema: ${theme === 'system' ? 'automático' : theme === 'dark' ? 'escuro' : 'claro'} (clique para alternar)`} aria-label="Alternar tema">
            <Icon size={17} />
          </button>
          {canLogout && (
            <button type="button" onClick={onLogout} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2" title="Encerrar sessão">
              <LogOut size={15} />
              Sair
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
