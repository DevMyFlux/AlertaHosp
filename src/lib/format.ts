// Formatação única de números, datas e unidades — todo gráfico e tabela passa por aqui,
// para que "1.234,5 kWh" seja sempre escrito do mesmo jeito.

const TZ = 'America/Sao_Paulo';

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

export const dash = '—';

/** kWh: 2 casas abaixo de 1, 1 casa até 1.000, inteiro acima. */
export function kwh(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  const a = Math.abs(v);
  return a < 1 ? nf2.format(v) : a < 1000 ? nf1.format(v) : nf0.format(v);
}

export const kwhUnit = (v: number | null | undefined) => (kwh(v) === dash ? dash : `${kwh(v)} kWh`);

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return Math.abs(v) >= 1000 ? brl0.format(v) : brl.format(v);
}

/** 0,64 → "+64%" */
export function pctOver(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return dash;
  return `${v >= 0 ? '+' : ''}${nf0.format(v * 100)}%`;
}

export const int = (v: number) => nf0.format(v);

function parts(iso: string | Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export const dateTime = (iso: string | null | undefined) => (iso ? parts(iso, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : dash);
export const dateTimeFull = (iso: string | null | undefined) => (iso ? parts(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : dash);
export const timeOnly = (iso: string | null | undefined) => (iso ? parts(iso, { hour: '2-digit', minute: '2-digit', hour12: false }) : dash);
export const dayMonth = (iso: string) => parts(iso, { day: '2-digit', month: '2-digit' });
export const weekdayDate = (iso: string) => parts(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });

export function duration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 48) return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function ago(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return 'sem dados';
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `há ${Math.round(minutes / 60)} h`;
  return `há ${Math.round(minutes / 1440)} d`;
}

/** "AAAA-MM-DD" no fuso de Brasília. */
export function isoDay(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;
}

export const SEVERITY_LABEL = { atencao: 'Atenção', alto: 'Alto', critico: 'Crítico' } as const;
export const STATE_LABEL = {
  normal: 'Normal',
  atencao: 'Atenção',
  alto: 'Alto',
  critico: 'Crítico',
  learning: 'Aprendendo',
  no_data: 'Sem dados',
  quarantine: 'Em estabilização',
} as const;
export const KIND_LABEL: Record<string, string> = { critico: 'Crítico', infra: 'Infraestrutura', imagem: 'Imagem', hvac: 'Climatização' };
