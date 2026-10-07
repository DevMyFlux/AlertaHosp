// Explicabilidade: transforma uma avaliação em (1) um payload estruturado que
// é gravado em cada evento do alerta e (2) uma frase em português que responde
// "por que esse alerta foi disparado?".

import type { Evaluation, LimitBinding, BaselineSnapshot } from './detector.js';
import { SEVERITY_LABEL, type Level, type Severity } from './types.js';
import { weekdayNamePt } from '../time.js';

export interface ExplainPayload {
  rule: string;
  value: number;
  expected: number;
  sigma: number;
  z: number | null;
  pctOver: number | null;
  excessKwh: number;
  level: Level;
  limits: Record<Severity, number>;
  binding: Record<Severity, LimitBinding>;
  envelope: number;
  window: { key: string; name: string; dayType: string };
  baseline: BaselineSnapshot;
  persistence: { required: number; observed: number };
  reason: string;
}

const kwh = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kwh2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function fmtKwh(v: number): string {
  return Math.abs(v) < 1 ? kwh2.format(v) : kwh.format(v);
}

function finiteOrNull(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

const BINDING_TEXT: Record<LimitBinding, string> = {
  z: 'variação estatística (mediana + z × σ)',
  pct: 'excesso relativo mínimo sobre o esperado',
  min_excess: 'excesso absoluto mínimo (ignora poucos kW)',
  envelope: 'maior valor já visto nesta faixa (P99 + tolerância)',
};

const DAY_TYPE_TEXT: Record<string, string> = { weekday: 'dias úteis', weekend: 'fins de semana', all: 'todos os dias' };

/** Frase principal: valor, esperado, desvio, faixa, base estatística e limite. */
export function describeEvaluation(ev: Evaluation, level: Level = ev.level): string {
  const base = ev.baseline;
  const dia = DAY_TYPE_TEXT[base.dayType] ?? base.dayType;
  const over = Number.isFinite(ev.pctOver) ? `${pct.format(ev.pctOver * 100)}% acima do esperado` : 'acima do esperado (referência ~0)';
  const head = `Consumo de ${fmtKwh(ev.value)} kWh no intervalo, ${over} (${fmtKwh(ev.expected)} kWh) para a faixa “${ev.windowName}” — ${dia}, ${base.n} leituras de referência.`;
  if (level === 'normal') return head;
  const limit = ev.limits[level];
  return `${head} Limite de ${SEVERITY_LABEL[level].toUpperCase()}: ${fmtKwh(limit)} kWh, definido por ${BINDING_TEXT[ev.binding[level]]}; desvio de ${fmtKwh(ev.z)}σ (σ = ${fmtKwh(ev.sigma)} kWh).`;
}

export function buildExplain(ev: Evaluation, persistence: { required: number; observed: number }): ExplainPayload {
  return {
    rule: ev.rulesVersion,
    value: ev.value,
    expected: ev.expected,
    sigma: ev.sigma,
    z: finiteOrNull(ev.z),
    pctOver: finiteOrNull(ev.pctOver),
    excessKwh: ev.excessKwh,
    level: ev.level,
    limits: ev.limits,
    binding: ev.binding,
    envelope: ev.envelope,
    window: { key: ev.windowKey, name: ev.windowName, dayType: ev.dayType },
    baseline: ev.baseline,
    persistence,
    reason: describeEvaluation(ev),
  };
}

/** "quinta-feira, 24/09 às 16:45" a partir de partes locais já calculadas. */
export function formatWeekdayDateTime(weekday: number, day: number, month: number, hour: number, minute: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${weekdayNamePt(weekday)}, ${p(day)}/${p(month)} às ${p(hour)}:${p(minute)}`;
}
