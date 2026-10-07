// Texto das notificações. Um único construtor para o WhatsApp (template de 9
// variáveis já aprovado na Meta) e para o SMS de contingência — a V1 tinha três
// cópias disso (backend + duas telas).
//
// Um "resumo" (digest) cobre vários setores da MESMA unidade no mesmo ciclo:
// o principal ocupa as variáveis e os demais entram em "também acima do
// esperado", na variável de causa. Uma mensagem em vez de N.

import { causeProfile } from './causes.js';
import { fmtKwh } from './explain.js';
import { SEVERITY_LABEL, type Severity } from './types.js';
import type { NotifyReason } from './policy.js';
import type { SectorKind } from '../units.js';
import { localParts, weekdayNamePt } from '../time.js';

export interface DigestItem {
  sectorCode: string;
  sectorName: string;
  kind: SectorKind;
  reason: NotifyReason;
  severity: Severity;
  openedAt: Date;
  /** instante da leitura que motivou o aviso */
  evaluatedAt: Date;
  /** excesso relativo da leitura mais alta do alerta (0,6 = +60%); null se sem referência */
  pctOver: number | null;
  totalExcessKwh: number;
  totalCostBrl: number;
  /** excesso do intervalo mais recente (base da projeção mensal) */
  lastExcessKwh: number;
  /** duração da faixa operacional em horas (base da projeção mensal) */
  windowHours: number;
  occurrences30d: number;
  /** a climatização associada também está bem acima do esperado */
  hvacElevated: boolean;
}

export interface DigestContext {
  unitCode: string;
  timezone: string;
  intervalMin: number;
  tariffBrlPerKwh: number;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 1024);

function formatPct(v: number | null): string {
  return v === null ? 'acima do esperado' : `${pct.format(v * 100)}%`;
}

/** Projeção mensal se o excesso do intervalo se repetir durante toda a faixa, todos os dias. */
export function monthlyProjectionBrl(item: Pick<DigestItem, 'lastExcessKwh' | 'windowHours'>, ctx: DigestContext): number {
  const intervalsPerHour = 60 / ctx.intervalMin;
  return item.lastExcessKwh * intervalsPerHour * item.windowHours * 30 * ctx.tariffBrlPerKwh;
}

function formatDuration(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return h < 48 ? `${pct.format(h)} h` : `${pct.format(h / 24)} dias`;
}

function occurrencesText(n: number): string {
  if (n <= 0) return 'sem registro de ocorrência semelhante nos últimos 30 dias';
  return `${n} ${n === 1 ? 'vez' : 'vezes'} nos últimos 30 dias`;
}

function reasonPrefix(item: DigestItem): string {
  switch (item.reason) {
    case 'escalated':
      return `Severidade elevada para ${SEVERITY_LABEL[item.severity].toUpperCase()}. `;
    case 'reminder': {
      const minutes = (item.evaluatedAt.getTime() - item.openedAt.getTime()) / 60000;
      return `Alerta ainda ativo há ${formatDuration(minutes)}. `;
    }
    case 'recovered':
      return 'Consumo voltou ao padrão. ';
    default:
      return '';
  }
}

function othersText(others: readonly DigestItem[]): string {
  if (others.length === 0) return '';
  const shown = others.slice(0, 4).map(o => `${o.sectorName} (${o.pctOver === null ? 'acima' : `+${pct.format(o.pctOver * 100)}%`})`);
  const rest = others.length - shown.length;
  return ` | Também acima do esperado: ${shown.join(', ')}${rest > 0 ? ` e mais ${rest}` : ''}.`;
}

/** As 9 variáveis do template WhatsApp, na ordem aprovada. */
export function buildWhatsAppParams(items: readonly DigestItem[], ctx: DigestContext): string[] {
  const [main, ...others] = items;
  if (!main) throw new Error('buildWhatsAppParams: resumo sem itens');
  const p = localParts(main.evaluatedAt, ctx.timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const profile = causeProfile(main.sectorCode, main.kind, main.hvacElevated);
  const sector = `${ctx.unitCode} - ${main.sectorName}`.toUpperCase();

  return [
    `${weekdayNamePt(p.weekday)}, ${pad(p.day)}/${pad(p.month)} às ${pad(p.hour)}:${pad(p.minute)}`,
    others.length > 0 ? `${sector} (+${others.length} ${others.length === 1 ? 'setor' : 'setores'})` : sector,
    formatPct(main.pctOver),
    `${fmtKwh(main.totalExcessKwh)} kWh`,
    brl.format(main.totalCostBrl),
    brl.format(monthlyProjectionBrl(main, ctx)),
    occurrencesText(main.occurrences30d),
    `${reasonPrefix(main)}${profile.cause}${othersText(others)}`,
    profile.action,
  ].map(oneLine);
}

/** SMS de contingência (só unidades com fallback habilitado): texto corrido, sem lista. */
export function buildSmsText(items: readonly DigestItem[], ctx: DigestContext): string {
  const [main, ...others] = items;
  if (!main) throw new Error('buildSmsText: resumo sem itens');
  const p = localParts(main.evaluatedAt, ctx.timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const profile = causeProfile(main.sectorCode, main.kind, main.hvacElevated);
  const lines = [
    `⚠️ ALERTA ${ctx.unitCode} - ${main.sectorName.toUpperCase()} (${SEVERITY_LABEL[main.severity]})`,
    '',
    `${reasonPrefix(main)}O consumo está ${formatPct(main.pctOver)} acima do padrão esperado para ${weekdayNamePt(p.weekday)} às ${pad(p.hour)}:${pad(p.minute)}. Ocorrências: ${occurrencesText(main.occurrences30d)}.`,
    '',
    `Causa provável: ${profile.causeLong}. ${profile.actionLong}`,
    '',
    `Excedente acumulado: ${fmtKwh(main.totalExcessKwh)} kWh (${brl.format(main.totalCostBrl)}). Se o padrão persistir, impacto projetado: ${brl.format(monthlyProjectionBrl(main, ctx))}/mês.`,
  ];
  if (others.length > 0) lines.push('', othersText(others).replace(/^ \| /, ''));
  lines.push('', 'Equipe Carbono Zero');
  return lines.join('\n');
}
