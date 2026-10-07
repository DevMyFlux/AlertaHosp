import { useState } from 'react';
import type { UnitCode } from '../../core/unitMeta';
import { CostBySectorChart, ConsumptionChart, HourChart } from '../charts/charts';
import { Empty, ErrorBox, PageTitle, Panel, Segmented, SeverityPill, Skeleton, Stat } from '../components/ui';
import { api } from '../lib/api';
import { ago, dateTime, duration, int, kwh, kwhUnit, money, dayMonth } from '../lib/format';
import { useRemote } from '../lib/hooks';
import { href } from '../lib/router';

const PERIODS = [
  { value: 1, label: '24 h' },
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
];

const EVENT_TEXT: Record<string, string> = {
  source_event: 'Reinício da fonte detectado',
  source_stale: 'Fonte sem atualização',
  source_resumed: 'Fonte voltou a enviar dados',
};

export function OverviewPage({ unit }: { unit: UnitCode }) {
  const [days, setDays] = useState(7);
  const ov = useRemote(signal => api.overview(unit, days, signal), [unit, days], 60_000);
  const d = ov.data;
  const periodLabel = days === 1 ? 'nas últimas 24 horas' : `nos últimos ${days} dias`;

  return (
    <>
      <PageTitle
        unit={unit}
        title="Visão geral"
        subtitle={d ? `Alertas ${periodLabel} · leituras a cada ${d.unit.intervalMin} min` : 'Carregando…'}
        actions={<Segmented label="Período" value={days} options={PERIODS} onChange={setDays} />}
      />

      {ov.error && !d && <ErrorBox error={ov.error} onRetry={ov.reload} />}

      {d?.freshness.sourceStatus === 'stale' && (
        <div role="status" className="mb-4 rounded-lg border px-4 py-3 text-[13px]" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)', color: 'var(--warn)' }}>
          <strong>Fonte de dados sem atualização</strong> — última leitura {ago(d.freshness.ageMinutes)}. Enquanto isso, nenhum alerta de consumo é gerado ou enviado para {unit}.
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {d ? (
          <>
            <Stat label={`Alertas ${periodLabel}`} value={int(d.totals.alerts)}
              sub={`${d.totals.byPeak.critico} crítico · ${d.totals.byPeak.alto} alto · ${d.totals.byPeak.atencao} atenção`} />
            <Stat label="Em aberto agora" value={int(d.totals.openNow)} tone={d.totals.openNow > 0 ? 'alto' : undefined}
              sub={d.totals.openNow ? 'ver lista ao lado' : 'nenhum desvio ativo'} />
            <Stat label="Excedente estimado" value={<>{kwh(d.totals.excessKwh)} <span className="text-sm font-normal text-ink-3">kWh</span></>}
              sub="consumo acima do esperado" />
            <Stat label="Custo estimado do excedente" value={money(d.totals.costBrl)}
              sub={`${int(d.totals.notificationsSent)} mensagem(ns) enviada(s) · estimativa`} />
          </>
        ) : (
          [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[84px]" />)
        )}
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Consumo por hora" hint="Soma dos medidores monitorados desta unidade, em kWh por hora">
          {d ? d.consumption.length > 0 ? <ConsumptionChart data={d.consumption} /> : <Empty title="Sem leituras no período" /> : <Skeleton className="h-64" />}
        </Panel>

        <Panel title="Alertas em aberto" hint="Setores acima do esperado neste momento" flush>
          {!d ? (
            <div className="p-4"><Skeleton className="h-32" /></div>
          ) : d.openAlerts.length === 0 ? (
            <Empty title="Nenhum alerta em aberto">Todos os setores monitorados de {unit} estão dentro do padrão esperado para o horário.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {d.openAlerts.map(a => (
                <li key={a.id}>
                  <a href={href(unit, 'alerts', a.id)} className="block px-4 py-3 no-underline hover:bg-surface-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{a.sectorName}</span>
                      <SeverityPill severity={a.severity} />
                    </div>
                    <div className="num mt-0.5 text-xs text-ink-3">
                      desde {dateTime(a.openedAt)} · {duration(a.durationMinutes)} · {kwhUnit(a.totalExcessKwh)} excedentes
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Setores com maior custo de excedente" hint={`Custo estimado do consumo acima do esperado ${periodLabel}`}>
          {d ? d.bySector.length > 0 ? <CostBySectorChart data={d.bySector} /> : <Empty title="Nenhum alerta no período" /> : <Skeleton className="h-48" />}
        </Panel>
        <Panel title="Em que horas os alertas acontecem" hint={`Alertas abertos por hora do dia ${periodLabel} — mostra recorrência`}>
          {d ? d.totals.alerts > 0 ? <HourChart data={d.byHour} /> : <Empty title="Nenhum alerta no período" /> : <Skeleton className="h-44" />}
        </Panel>
      </div>

      <Panel title="Qualidade dos dados da fonte" hint="Reinícios e quedas são detectados; as leituras afetadas são isoladas e nunca geram alerta">
        {!d ? <Skeleton className="h-16" /> : d.sourceEvents.length === 0 ? (
          <p className="text-[13px] text-ink-3">Nenhum reinício ou queda da fonte {periodLabel}.</p>
        ) : (
          <ul className="grid gap-1.5 text-[13px] sm:grid-cols-2">
            {d.sourceEvents.map((e, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-1.5">
                <span>{EVENT_TEXT[e.kind] ?? e.kind}</span>
                <span className="num text-xs text-ink-3">{dayMonth(e.ts)} · {dateTime(e.ts).slice(-5)}{typeof e.detail.affectedSectors === 'number' ? ` · ${e.detail.affectedSectors} medidores` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
