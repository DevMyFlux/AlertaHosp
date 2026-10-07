// Primitivos de interface. Visual enxuto: bordas finas, sem sombras decorativas,
// cor só quando significa algo (unidade, severidade, estado).
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { UnitCode } from '../../core/unitMeta';
import { UNIT_META } from '../../core/unitMeta';
import { SEVERITY_LABEL, STATE_LABEL } from '../lib/format';
import type { SectorStateKey, Severity } from '../lib/types';
import type { ApiError } from '../lib/api';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ─── Botões e seletores ─────────────────────────────────────────────────────────────────────────

export function Button({
  children, onClick, variant = 'secondary', disabled, title, type = 'button', className,
}: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost'; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    primary: 'bg-unit text-[color:var(--unit-ink)] border-transparent hover:brightness-110',
    secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-2',
    ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-surface-2',
  }[variant];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={cx('inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed', styles, className)}>
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({
  value, options, onChange, label,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
      {options.map(o => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          className={cx('rounded px-2.5 py-1 text-[13px] font-medium transition-colors', o.value === value ? 'bg-ink text-surface' : 'text-ink-2 hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Identidade da unidade ───────────────────────────────────────────────────────────────────────

/** Selo da unidade — aparece em todo título de página, tabela e drawer. */
export function UnitBadge({ unit, size = 'md' }: { unit: UnitCode; size?: 'sm' | 'md' }) {
  return (
    <span className={cx('inline-flex items-center rounded font-semibold tracking-wide', size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs')}
      style={{ background: 'var(--unit-soft)', color: 'var(--unit)' }} title={`Unidade ${UNIT_META[unit].name}`}>
      {unit}
    </span>
  );
}

// ─── Estados e severidades ───────────────────────────────────────────────────────────────────────

const TONE: Record<string, { fg: string; bg: string }> = {
  atencao: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
  alto: { fg: 'var(--alto)', bg: 'var(--alto-soft)' },
  critico: { fg: 'var(--crit)', bg: 'var(--crit-soft)' },
  normal: { fg: 'var(--ok)', bg: 'var(--ok-soft)' },
  muted: { fg: 'var(--ink-3)', bg: 'var(--muted-soft)' },
};

export function Pill({ tone, children }: { tone: keyof typeof TONE | string; children: ReactNode }) {
  const t = TONE[tone] ?? TONE.muted;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: t.fg, background: t.bg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.fg }} />
      {children}
    </span>
  );
}

export function SeverityPill({ severity }: { severity: Severity | null }) {
  return severity ? <Pill tone={severity}>{SEVERITY_LABEL[severity]}</Pill> : <Pill tone="muted">Não classificado</Pill>;
}

export function StatePill({ state }: { state: SectorStateKey }) {
  const tone = state === 'learning' || state === 'no_data' || state === 'quarantine' ? 'muted' : state;
  return <Pill tone={tone}>{STATE_LABEL[state]}</Pill>;
}

// ─── Estrutura ───────────────────────────────────────────────────────────────────────────────────

export function PageTitle({ unit, title, subtitle, actions }: { unit: UnitCode; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
          <UnitBadge unit={unit} />
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, hint, actions, children, className, flush }: { title?: string; hint?: string; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="num mt-1 text-2xl font-semibold tracking-tight" style={tone ? { color: TONE[tone]?.fg } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

// ─── Carregamento, vazio e erro ───────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-md text-[13px] text-ink-3">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: 'var(--crit)', background: 'var(--crit-soft)', color: 'var(--crit)' }}>
      <div>
        <div className="font-semibold">Não foi possível carregar</div>
        <div className="mt-0.5 opacity-90">{error.status === 503 ? 'O banco de dados não está disponível no momento.' : error.message}</div>
      </div>
      {onRetry && <Button onClick={onRetry} variant="secondary">Tentar de novo</Button>}
    </div>
  );
}

// ─── Gaveta lateral ───────────────────────────────────────────────────────────────────────────────

export function Drawer({ open, onClose, title, subtitle, children }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className="relative flex h-full w-full max-w-[640px] flex-col border-l border-line bg-surface outline-none" style={{ boxShadow: 'var(--shadow-pop)' }}>
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="text-base font-semibold">{title}</div>
            {subtitle && <div className="mt-0.5 text-xs text-ink-3">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
