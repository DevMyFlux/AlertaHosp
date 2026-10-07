import { useMemo, useState } from 'react';
import type { UnitCode } from '../../core/unitMeta';
import { SectorChart } from '../charts/charts';
import { Drawer, Empty, ErrorBox, PageTitle, Panel, Segmented, Skeleton, StatePill, UnitBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { KIND_LABEL, STATE_LABEL, dateTime, dateTimeFull, dash, kwh, kwhUnit, pctOver } from '../lib/format';
import { useRemote } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import type { SectorSnapshot, SectorStateKey } from '../lib/types';

const FILTERS: { value: 'all' | 'attention' | 'normal'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'attention', label: 'Fora do padrão' },
  { value: 'normal', label: 'Normais' },
];

const isAttention = (s: SectorStateKey) => s === 'atencao' || s === 'alto' || s === 'critico';
const ORDER: Record<SectorStateKey, number> = { critico: 0, alto: 1, atencao: 2, quarantine: 3, learning: 4, no_data: 5, normal: 6 };

/** Barra "bala": onde o consumo atual está em relação ao esperado e aos limites. */
function LevelBar({ s }: { s: SectorSnapshot }) {
  if (s.valueKwh === null || s.expectedKwh === null || !s.limits) return <span className="text-ink-3">{dash}</span>;
  const max = Math.max(s.limits.critico * 1.05, s.valueKwh * 1.05, 0.0001);
  const pos = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const color = s.state === 'critico' ? 'var(--crit)' : s.state === 'alto' ? 'var(--alto)' : s.state === 'atencao' ? 'var(--warn)' : 'var(--unit)';
  return (
    <div className="relative h-2 w-40 rounded-full bg-surface-2" title={`Esperado ${kwhUnit(s.expectedKwh)} · atenção > ${kwhUnit(s.limits.atencao)} · alto > ${kwhUnit(s.limits.alto)} · crítico > ${kwhUnit(s.limits.critico)}`}>
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pos(s.valueKwh), background: color }} />
      {[s.limits.atencao, s.limits.alto, s.limits.critico].map((l, i) => (
        <div key={i} className="absolute -top-0.5 h-3 w-px bg-line-strong" style={{ left: pos(l) }} />
      ))}
      <div className="absolute -top-1 h-4 w-0.5 rounded bg-ink" style={{ left: pos(s.expectedKwh) }} />
    </div>
  );
}

function SectorDrawer({ unit, intervalMin, sector, onClose }: { unit: UnitCode; intervalMin: number; sector: SectorSnapshot | undefined; code: string; onClose: () => void } & { code: string }) {
  const [hours, setHours] = useState(48);
  const series = useRemote(signal => (sector ? api.series(unit, sector.code, { hours }, signal) : Promise.reject(new Error('none'))), [unit, sector?.code, hours]);
  return (
    <Drawer open onClose={onClose}
      title={<span className="flex items-center gap-2"><UnitBadge unit={unit} />{sector?.name ?? '…'}</span>}
      subtitle={sector ? `${KIND_LABEL[sector.kind] ?? sector.kind} · leituras a cada ${intervalMin} min` : undefined}>
      {!sector ? <Empty title="Setor não encontrado nesta unidade" /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <Fact label="Estado" value={<StatePill state={sector.state} />} />
            <Fact label="Agora" value={kwhUnit(sector.valueKwh)} />
            <Fact label="Esperado" value={kwhUnit(sector.expectedKwh)} />
            <Fact label="Desvio" value={pctOver(sector.pctOver)} />
            <Fact label="Faixa horária" value={sector.window ?? dash} />
            <Fact label="Limite de atenção" value={kwhUnit(sector.limits?.atencao)} />
            <Fact label="Limite alto" value={kwhUnit(sector.limits?.alto)} />
            <Fact label="Leituras de referência" value={sector.baselineSamples?.toString() ?? dash} />
          </div>
          {sector.openAlertId && (
            <a href={href(unit, 'alerts', sector.openAlertId)} className="block rounded-md border px-3 py-2 text-[13px] no-underline" style={{ borderColor: 'var(--alto)', background: 'var(--alto-soft)', color: 'var(--alto)' }}>
              Alerta em aberto desde {dateTime(sector.openedAt)} — ver detalhes e explicação →
            </a>
          )}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Consumo, esperado e limites</h3>
              <Segmented label="Janela" value={hours} onChange={setHours} options={[{ value: 24, label: '24 h' }, { value: 48, label: '48 h' }, { value: 168, label: '7 dias' }]} />
            </div>
            {series.error ? <ErrorBox error={series.error} onRetry={series.reload} /> : series.data ? <SectorChart points={series.data.points} intervalMin={intervalMin} /> : <Skeleton className="h-72" />}
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
              <li><span className="mr-1.5 inline-block h-0.5 w-4 align-middle" style={{ background: 'var(--unit)' }} />consumo</li>
              <li><span className="mr-1.5 inline-block h-0.5 w-4 align-middle" style={{ background: 'var(--ink-3)' }} />esperado (mediana da faixa)</li>
              <li><span className="mr-1.5 inline-block h-0 w-4 border-t border-dashed align-middle" style={{ borderColor: 'var(--warn)' }} />limite de atenção</li>
              <li><span className="mr-1.5 inline-block h-0 w-4 border-t border-dotted align-middle" style={{ borderColor: 'var(--alto)' }} />limite alto</li>
            </ul>
          </div>
          {sector.flags.length > 0 && <p className="text-xs text-ink-3">Última leitura: {dateTimeFull(sector.ts)} · marcações: {sector.flags.join(', ')}</p>}
        </div>
      )}
    </Drawer>
  );
}

const Fact = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
    <div className="num mt-0.5 font-medium">{value}</div>
  </div>
);

export function SectorsPage({ unit, selected, intervalMin }: { unit: UnitCode; selected: string | null; intervalMin: number }) {
  const [filter, setFilter] = useState<'all' | 'attention' | 'normal'>('all');
  const res = useRemote(signal => api.sectors(unit, signal), [unit], 60_000);
  const sectors = useMemo(() => {
    const list = (res.data?.sectors ?? []).filter(s => s.monitored);
    const filtered = list.filter(s => (filter === 'attention' ? isAttention(s.state) : filter === 'normal' ? s.state === 'normal' : true));
    return filtered.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.pctOver ?? -1) - (a.pctOver ?? -1) || a.name.localeCompare(b.name, 'pt-BR'));
  }, [res.data, filter]);
  const counts = useMemo(() => {
    const all = (res.data?.sectors ?? []).filter(s => s.monitored);
    return { total: all.length, attention: all.filter(s => isAttention(s.state)).length };
  }, [res.data]);

  return (
    <>
      <PageTitle unit={unit} title="Setores"
        subtitle={res.data ? `${counts.total} setores monitorados · ${counts.attention ? `${counts.attention} fora do padrão agora` : 'todos dentro do padrão'}` : 'Carregando…'}
        actions={<Segmented label="Filtro" value={filter} onChange={setFilter} options={FILTERS} />} />
      {res.error && !res.data && <ErrorBox error={res.error} onRetry={res.reload} />}
      {res.data?.sectors.some(s => s.monitored && s.stale) && (
        <div role="status" className="mb-3 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          <strong>Leituras desatualizadas</strong> — a fonte de dados de {unit} não está enviando. Os estados abaixo são os da última leitura recebida, não do momento atual.
        </div>
      )}
      <Panel flush>
        {!res.data ? <div className="p-4"><Skeleton className="h-64" /></div> : sectors.length === 0 ? (
          <Empty title="Nenhum setor neste filtro" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Setor</th><th>Tipo</th><th className="r">Agora (kWh)</th><th className="r">Esperado (kWh)</th><th className="r">Desvio</th>
                  <th>Posição nos limites</th><th>Estado</th><th>Leitura</th>
                </tr>
              </thead>
              <tbody>
                {sectors.map(s => (
                  <tr key={s.code} data-clickable="true" onClick={() => navigate(unit, 'sectors', s.code)} className={cx(selected === s.code && 'bg-unit-soft')}>
                    <td className="font-medium">{s.name}</td>
                    <td className="text-ink-3">{KIND_LABEL[s.kind] ?? s.kind}</td>
                    <td className="num r">{kwh(s.valueKwh)}</td>
                    <td className="num r text-ink-2">{kwh(s.expectedKwh)}</td>
                    <td className={cx('num r', isAttention(s.state) && 'font-medium')}>{pctOver(s.pctOver)}</td>
                    <td><LevelBar s={s} /></td>
                    <td><span className={s.stale ? 'opacity-50' : undefined} title={s.stale ? 'Leitura desatualizada — a fonte não está enviando dados' : undefined}><StatePill state={s.state} /></span></td>
                    <td className="num text-xs text-ink-3">{dateTime(s.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-3 text-xs text-ink-3">
        A barra mostra o consumo atual (preenchimento) contra o esperado (traço escuro) e os limites de atenção, alto e crítico (traços claros).
        Estados: {Object.values(STATE_LABEL).join(' · ')}. “Aprendendo” = poucas leituras de referência para esta faixa horária.
      </p>
      {selected && <SectorDrawer unit={unit} code={selected} intervalMin={intervalMin} sector={res.data?.sectors.find(s => s.code === selected)} onClose={() => navigate(unit, 'sectors')} />}
    </>
  );
}
