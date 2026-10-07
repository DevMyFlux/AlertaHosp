import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { UNIT_CODES, type UnitCode } from '../../core/unitMeta';
import { SectorChart } from '../charts/charts';
import { Button, Drawer, Empty, ErrorBox, PageTitle, Panel, Pill, Segmented, SeverityPill, Skeleton, UnitBadge } from '../components/ui';
import { api, reportUrl } from '../lib/api';
import { dash, dateTime, dateTimeFull, duration, int, isoDay, kwh, kwhUnit, money, pctOver } from '../lib/format';
import { useRemote } from '../lib/hooks';
import { navigate } from '../lib/router';
import type { AlertEvent, AlertItem, UnitInfo } from '../lib/types';

const PERIODS = [
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
];
const PAGE = 50;

// ─── exportação ──────────────────────────────────────────────────────────────────────────────────

function ExportMenu({ unit, days }: { unit: UnitCode; days: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const to = isoDay(new Date());
  const from = isoDay(new Date(Date.now() - days * 86400000));
  const items: { label: string; units: UnitCode[]; format: 'xlsx' | 'pdf' }[] = [
    { label: `Excel — ${unit}`, units: [unit], format: 'xlsx' },
    { label: `PDF — ${unit}`, units: [unit], format: 'pdf' },
    { label: 'Excel — HCN e HMB (abas separadas)', units: [...UNIT_CODES], format: 'xlsx' },
    { label: 'PDF — HCN e HMB (seções separadas)', units: [...UNIT_CODES], format: 'pdf' },
  ];
  return (
    <div ref={ref} className="relative">
      <Button onClick={() => setOpen(o => !o)}><Download size={15} />Exportar<ChevronDown size={14} /></Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-line-strong bg-surface py-1 text-[13px]" style={{ boxShadow: 'var(--shadow-pop)' }} role="menu">
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Período: últimos {days} dias</div>
          {items.map((it, i) => (
            <a key={it.label} role="menuitem" href={reportUrl(it.units, it.format, from, to)} onClick={() => setOpen(false)}
              className={`block px-3 py-2 text-ink no-underline hover:bg-surface-2 ${i === 2 ? 'border-t border-line' : ''}`}>
              {it.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── detalhe de um alerta ──────────────────────────────────────────────────────────────────────

const EVENT_LABEL: Record<AlertEvent['type'], string> = {
  opened: 'Alerta aberto',
  reopened: 'Alerta reaberto (mesmo evento)',
  escalated: 'Severidade elevada',
  breach: 'Leitura acima do limite',
  recovered: 'Recuperado — consumo voltou ao padrão',
};

function AlertDetailDrawer({ unit, id, intervalMin, onClose }: { unit: UnitCode; id: number; intervalMin: number; onClose: () => void }) {
  const detail = useRemote(signal => api.alert(unit, id, signal), [unit, id]);
  const a = detail.data?.alert;
  const window = useMemo(() => {
    if (!a) return null;
    const from = new Date(new Date(a.openedAt).getTime() - 4 * 3600000);
    const end = a.recoveredAt ? new Date(a.recoveredAt) : new Date();
    const to = new Date(Math.min(end.getTime() + 3 * 3600000, Date.now()));
    return { from: from.toISOString(), to: to.toISOString(), hi: { from: a.openedAt, to: (a.recoveredAt ?? new Date().toISOString()) } };
  }, [a]);
  const series = useRemote(signal => (a && a.origin === 'engine' && window ? api.series(unit, a.sectorCode, { from: window.from, to: window.to }, signal) : Promise.resolve(null)), [unit, a?.id]);
  const shownEvents = (detail.data?.events ?? []).filter(e => e.type !== 'breach');
  const breaches = (detail.data?.events ?? []).filter(e => e.type === 'breach');

  return (
    <Drawer open onClose={onClose}
      title={<span className="flex items-center gap-2"><UnitBadge unit={unit} />{a ? a.sectorName : `Alerta #${id}`}</span>}
      subtitle={a ? `Alerta #${a.id} · faixa “${a.windowName}”` : undefined}>
      {detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : !a ? <Skeleton className="h-64" /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3">
            <Fact label="Severidade (pico)"><SeverityPill severity={a.peakSeverity} /></Fact>
            <Fact label="Situação">{a.status === 'open' ? <Pill tone="alto">Em aberto</Pill> : <Pill tone="normal">Recuperado</Pill>}</Fact>
            <Fact label="Duração">{duration(a.durationMinutes)}</Fact>
            <Fact label="Início">{dateTimeFull(a.openedAt)}</Fact>
            <Fact label="Fim">{a.recoveredAt ? dateTimeFull(a.recoveredAt) : 'em andamento'}</Fact>
            <Fact label="Mensagens enviadas">{int(a.notificationCount)}</Fact>
            <Fact label="Pico no intervalo">{kwhUnit(a.peakValueKwh)}</Fact>
            <Fact label="Esperado">{kwhUnit(a.baselineKwh)}</Fact>
            <Fact label="Desvio no pico">{pctOver(a.peakPctOver)}</Fact>
            <Fact label="Excedente acumulado">{kwhUnit(a.totalExcessKwh)}</Fact>
            <Fact label="Custo estimado">{money(a.totalCostBrl)}</Fact>
            <Fact label="Tarifa usada">{`R$ ${a.tariffBrlPerKwh.toFixed(2).replace('.', ',')}/kWh`}</Fact>
          </div>
          {a.suspect && (
            <div className="rounded-md border px-3 py-2 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}>
              <strong>Registro suspeito (importado da versão anterior):</strong> {a.suspectReason}. Não entra nos totais nem nos relatórios.
            </div>
          )}
          {a.origin === 'legacy_import' ? (
            <p className="text-[13px] text-ink-3">Registro importado do histórico da versão anterior — não há linha do tempo nem explicação estatística para este evento.</p>
          ) : (
            <>
              {window && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">O que aconteceu</h3>
                  {series.data ? <SectorChart points={series.data.points} intervalMin={intervalMin} highlight={window.hi} /> : <Skeleton className="h-72" />}
                  <p className="mt-1 text-xs text-ink-3">Área destacada = período do alerta. Linha cinza = esperado; tracejadas = limites de atenção e alto.</p>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-sm font-semibold">Por que disparou?</h3>
                <ol className="space-y-3 border-l border-line pl-4">
                  {shownEvents.map(e => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface" style={{ background: e.type === 'recovered' ? 'var(--ok)' : 'var(--alto)' }} />
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="font-medium">{EVENT_LABEL[e.type]}</span>
                        {e.severity && <SeverityPill severity={e.severity} />}
                        <span className="num text-xs text-ink-3">{dateTimeFull(e.ts)}</span>
                      </div>
                      {e.explain.reason && <p className="mt-1 text-[13px] text-ink-2">{e.explain.reason}</p>}
                      <div className="num mt-1 flex flex-wrap gap-x-4 text-xs text-ink-3">
                        <span>consumo {kwhUnit(e.valueKwh)}</span><span>esperado {kwhUnit(e.expectedKwh)}</span><span>limite {kwhUnit(e.limitKwh)}</span>
                        {e.z !== null && <span>{kwh(e.z)}σ</span>}
                        {e.explain.persistence && <span>persistência {e.explain.persistence.observed}/{e.explain.persistence.required} leituras</span>}
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-ink-3">{breaches.length} leitura(s) acima do limite registradas durante o alerta. Regra: {shownEvents[0]?.explain.rule ?? dash}.</p>
              </div>
              {detail.data!.notifications.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Mensagens</h3>
                  <ul className="space-y-1 text-[13px]">
                    {detail.data!.notifications.map(n => (
                      <li key={n.id} className="flex justify-between rounded-md bg-surface-2 px-3 py-1.5">
                        <span>{{ opened: 'Aviso de abertura', escalated: 'Aviso de escalonamento', reminder: 'Lembrete', recovered: 'Aviso de recuperação' }[n.reason] ?? n.reason}</span>
                        <span className="num text-xs text-ink-3">{dateTime(n.createdAt)} · {{ sent: 'enviada', failed: 'falhou', suppressed: 'não enviada (modo sombra)', queued: 'na fila', sending: 'enviando' }[n.status] ?? n.status}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
    <div className="num mt-0.5 font-medium">{children}</div>
  </div>
);

// ─── lista ───────────────────────────────────────────────────────────────────────────────────────

export function AlertsPage({ unit, selectedId, info }: { unit: UnitCode; selectedId: number | null; info: UnitInfo | undefined }) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [sector, setSector] = useState('');
  const [limit, setLimit] = useState(PAGE);

  // trocar de unidade ou de filtro volta para a primeira página; setor de outra unidade não vale
  useEffect(() => { setSector(''); }, [unit]);
  useEffect(() => { setLimit(PAGE); }, [unit, days, status, severity, sector]);

  const from = useMemo(() => new Date(Date.now() - days * 86400000).toISOString(), [days]);
  const res = useRemote(signal => api.alerts(unit, { from, status: status || undefined, severity: severity || undefined, sector: sector || undefined, limit }, signal), [unit, from, status, severity, sector, limit]);
  const items: AlertItem[] = res.data?.items ?? [];
  const sectorOptions = (info?.sectors ?? []).filter(s => s.monitored);

  return (
    <>
      <PageTitle unit={unit} title="Alertas"
        subtitle={res.data ? `${int(res.data.total)} alerta(s) nos últimos ${days} dias` : 'Carregando…'}
        actions={<><Segmented label="Período" value={days} options={PERIODS} onChange={setDays} /><ExportMenu unit={unit} days={days} /></>} />

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <Select label="Situação" value={status} onChange={setStatus} options={[['', 'Todas as situações'], ['open', 'Em aberto'], ['recovered', 'Recuperados']]} />
        <Select label="Severidade" value={severity} onChange={setSeverity} options={[['', 'Todas as severidades'], ['critico', 'Crítico'], ['alto', 'Alto'], ['atencao', 'Atenção']]} />
        <Select label="Setor" value={sector} onChange={setSector} options={[['', `Todos os setores de ${unit}`], ...sectorOptions.map(s => [s.code, s.name] as [string, string])]} />
      </div>

      {res.error && !res.data && <ErrorBox error={res.error} onRetry={res.reload} />}
      <Panel flush>
        {!res.data ? <div className="p-4"><Skeleton className="h-64" /></div> : items.length === 0 ? (
          <Empty title="Nenhum alerta neste filtro">Sem desvios relevantes de {unit} no período. Alertas de atenção ficam só no painel; a partir de “alto” também geram mensagem.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Início</th><th>Setor</th><th>Severidade</th><th className="r">Duração</th><th className="r">Pico (kWh)</th><th className="r">Esperado</th>
                  <th className="r">Excedente (kWh)</th><th className="r">Custo est.</th><th className="r">Msgs</th><th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {items.map(a => (
                  <tr key={a.id} data-clickable="true" onClick={() => navigate(unit, 'alerts', a.id)}>
                    <td className="num whitespace-nowrap">{dateTime(a.openedAt)}</td>
                    <td className="font-medium">{a.sectorName}{a.suspect && <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--warn)' }}>suspeito</span>}</td>
                    <td><SeverityPill severity={a.peakSeverity} /></td>
                    <td className="num r">{duration(a.durationMinutes)}</td>
                    <td className="num r">{a.peakValueKwh ? kwh(a.peakValueKwh) : dash}</td>
                    <td className="num r text-ink-2">{a.baselineKwh ? kwh(a.baselineKwh) : dash}</td>
                    <td className="num r">{kwh(a.totalExcessKwh)}</td>
                    <td className="num r">{money(a.totalCostBrl)}</td>
                    <td className="num r">{a.notificationCount}</td>
                    <td>{a.status === 'open' ? <Pill tone="alto">Em aberto</Pill> : <Pill tone="muted">Recuperado</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {res.data && res.data.total > items.length && (
        <div className="mt-3 text-center"><Button onClick={() => setLimit(l => l + PAGE)}>Mostrar mais ({res.data.total - items.length} restantes)</Button></div>
      )}
      <p className="mt-3 text-xs text-ink-3">Excedente e custo são estimativas (consumo acima do esperado × tarifa da unidade). Ocorrências suspeitas importadas da versão anterior ficam fora dos totais.</p>
      {selectedId && <AlertDetailDrawer unit={unit} id={selectedId} intervalMin={info?.intervalMin ?? 15} onClose={() => navigate(unit, 'alerts')} />}
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}
      className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-[color:var(--unit)]">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
