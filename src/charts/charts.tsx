// Gráficos. Todos seguem o mesmo padrão: título e pergunta no Panel que os contém,
// eixos com unidade, mesma grade/tipografia, números e datas pelo mesmo formatador.
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dateTime, dayMonth, int, kwh, kwhUnit, money, timeOnly, weekdayDate } from '../lib/format';
import type { Overview, SeriesPoint } from '../lib/types';

const axis = { stroke: 'var(--chart-axis)', fontSize: 11, tickLine: false as const, axisLine: { stroke: 'var(--line)' } };
const grid = <CartesianGrid stroke="var(--chart-grid)" vertical={false} />;

interface TipProps {
  active?: boolean;
  payload?: { value?: number | string; name?: string; color?: string; dataKey?: string | number; payload?: Record<string, any> }[];
  label?: string | number;
  title: (label: string, row: Record<string, any>) => string;
  rows: (p: NonNullable<TipProps['payload']>[number], row: Record<string, any>) => { name: string; value: string; color?: string } | null;
}

function Tip({ active, payload, label, title, rows }: TipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload ?? {};
  return (
    <div className="rounded-md border border-line-strong bg-surface px-3 py-2 text-xs" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <div className="mb-1 font-semibold">{title(String(label), row)}</div>
      {payload.map((p, i) => {
        const r = rows(p, row);
        return r ? (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-ink-2">
              <span className="h-2 w-2 rounded-sm" style={{ background: r.color ?? p.color }} />
              {r.name}
            </span>
            <span className="num font-medium">{r.value}</span>
          </div>
        ) : null;
      })}
    </div>
  );
}

// ─── Consumo ao longo do tempo (visão geral) ──────────────────────────────────────────────────

export function ConsumptionChart({ data }: { data: Overview['consumption'] }) {
  const spanDays = data.length / 24;
  const tick = (iso: string) => (spanDays > 2 ? `${dayMonth(iso + ':00-03:00')} ${iso.slice(11, 13)}h` : `${iso.slice(11, 13)}h`);
  return (
    <div className="h-64" role="img" aria-label="Consumo por hora, soma dos medidores monitorados">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {grid}
          <XAxis dataKey="hour" tickFormatter={tick} minTickGap={36} {...axis} />
          <YAxis tickFormatter={v => int(v)} width={52} {...axis} label={{ value: 'kWh/h', angle: -90, position: 'insideLeft', fill: 'var(--chart-axis)', fontSize: 11, dx: 6 }} />
          <Tooltip content={<Tip title={(l, row) => `${weekdayDate(`${l}:00-03:00`)} ${String(l).slice(11, 13)}:00${row.coverage < 0.8 ? ' (dados parciais)' : ''}`} rows={p => ({ name: 'Consumo', value: kwhUnit(Number(p.value)), color: 'var(--unit)' })} />} />
          <Area type="monotone" dataKey="kwh" stroke="var(--unit)" strokeWidth={2} fill="var(--unit)" fillOpacity={0.1} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Custo estimado por setor ───────────────────────────────────────────────────────────────────

export function CostBySectorChart({ data }: { data: Overview['bySector'] }) {
  const rows = data.slice(0, 8);
  return (
    <div style={{ height: Math.max(120, rows.length * 34 + 24) }} role="img" aria-label="Custo estimado do excedente por setor">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
          <XAxis type="number" tickFormatter={v => money(v)} {...axis} />
          <YAxis type="category" dataKey="sectorName" width={118} {...axis} tick={{ fill: 'var(--ink-2)', fontSize: 12 }} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={
              <Tip
                title={(l, row) => `${l} — ${int(row.alerts)} alerta${row.alerts === 1 ? '' : 's'}`}
                rows={(p, row) => (p.dataKey === 'costBrl' ? { name: `Custo estimado · ${kwhUnit(row.excessKwh)} excedentes`, value: money(Number(p.value)) } : null)}
              />
            }
          />
          <Bar dataKey="costBrl" fill="var(--unit)" radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Quando os alertas acontecem (hora do dia) ────────────────────────────────────────────────

export function HourChart({ data }: { data: Overview['byHour'] }) {
  const full = Array.from({ length: 24 }, (_, h) => ({ hour: h, alerts: data.find(d => d.hour === h)?.alerts ?? 0 }));
  const max = Math.max(1, ...full.map(f => f.alerts));
  return (
    <div className="h-44" role="img" aria-label="Alertas abertos por hora do dia">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={full} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {grid}
          <XAxis dataKey="hour" tickFormatter={h => `${h}h`} interval={2} {...axis} />
          <YAxis allowDecimals={false} width={28} {...axis} />
          <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={<Tip title={l => `${String(l).padStart(2, '0')}h às ${String((Number(l) + 1) % 24).padStart(2, '0')}h`} rows={p => ({ name: 'Alertas abertos', value: int(Number(p.value)) })} />} />
          <Bar dataKey="alerts" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {full.map(f => (
              <Cell key={f.hour} fill="var(--unit)" fillOpacity={f.alerts === 0 ? 0.15 : 0.35 + 0.65 * (f.alerts / max)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Série de um setor com faixa esperada e limites ───────────────────────────────────────────

export function SectorChart({ points, intervalMin, highlight }: { points: SeriesPoint[]; intervalMin: number; highlight?: { from: string; to: string } | null }) {
  const data = points.map(p => ({ ...p, valid: p.status === 'ok' || p.status === 'gap' ? p.kwh : null }));
  const spanH = points.length ? (new Date(points[points.length - 1].ts).getTime() - new Date(points[0].ts).getTime()) / 3600000 : 0;
  const tick = (iso: string) => (spanH > 30 ? `${dayMonth(iso)} ${timeOnly(iso).slice(0, 2)}h` : timeOnly(iso));
  return (
    <div className="h-72" role="img" aria-label={`Consumo a cada ${intervalMin} minutos com esperado e limites`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {grid}
          <XAxis dataKey="ts" tickFormatter={tick} minTickGap={44} {...axis} />
          <YAxis tickFormatter={v => kwh(v)} width={48} {...axis} label={{ value: `kWh/${intervalMin} min`, angle: -90, position: 'insideLeft', fill: 'var(--chart-axis)', fontSize: 11, dx: 8 }} />
          {highlight && <ReferenceArea x1={highlight.from} x2={highlight.to} fill="var(--crit)" fillOpacity={0.08} stroke="none" ifOverflow="extendDomain" />}
          <Tooltip content={<Tip title={l => dateTime(String(l))} rows={p => {
            const names: Record<string, string> = { valid: 'Consumo', expected: 'Esperado', limitAtencao: 'Limite de atenção', limitAlto: 'Limite alto' };
            return p.dataKey && names[String(p.dataKey)] && p.value !== null && p.value !== undefined ? { name: names[String(p.dataKey)], value: kwhUnit(Number(p.value)) } : null;
          }} />} />
          <Line type="stepAfter" dataKey="limitAlto" stroke="var(--alto)" strokeDasharray="2 4" strokeWidth={1.25} dot={false} isAnimationActive={false} connectNulls />
          <Line type="stepAfter" dataKey="limitAtencao" stroke="var(--warn)" strokeDasharray="5 4" strokeWidth={1.25} dot={false} isAnimationActive={false} connectNulls />
          <Line type="stepAfter" dataKey="expected" stroke="var(--ink-3)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="valid" stroke="var(--unit)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
