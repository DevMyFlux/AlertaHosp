// Detector: compara UMA leitura com o baseline e devolve um nível, com todos
// os números que explicam a decisão ("por que esse alerta foi disparado?").
//
// Para cada nível (atenção/alto/crítico) o limite em kWh é o MAIOR entre:
//   1. mediana + z × σ            (variação estatística)
//   2. mediana × (1 + pct)        (excesso relativo mínimo)
//   3. mediana + excesso mínimo   (piso absoluto — ignora ruído de poucos kW)
//   4. envelope = P99 × (1 + tol) (nada que o setor já fez na faixa é anomalia)
// A leitura só vira nível X se ultrapassar o limite de X. σ nunca é menor que
// um piso (fração da mediana, potência mínima e degrau do contador), para que
// setores muito estáveis não disparem por um degrau de 1 kWh.

import type { RuleSet } from './rules.js';
import type { BaselineStats } from './baseline.js';
import type { OperationalWindow } from './windows.js';
import type { Level, Severity } from './types.js';
import { SEVERITIES } from './types.js';
import type { DayType } from '../time.js';

export type LimitBinding = 'z' | 'pct' | 'min_excess' | 'envelope';

export interface BaselineSnapshot {
  windowKey: string;
  dayType: DayType | 'all';
  n: number;
  median: number;
  /** σ robusto bruto (MAD × 1,4826) */
  sigmaRaw: number;
  p99: number;
  quantum: number;
  from: string;
  to: string;
}

export interface Evaluation {
  level: Level;
  /** consumo do intervalo (kWh) */
  value: number;
  /** consumo esperado = mediana do baseline (kWh) */
  expected: number;
  /** σ efetivo, já com pisos (kWh) */
  sigma: number;
  /** desvios robustos acima do esperado */
  z: number;
  /** excesso relativo sobre o esperado (0,35 = +35%) */
  pctOver: number;
  /** excesso sobre o esperado (kWh, nunca negativo) */
  excessKwh: number;
  /** limite de cada nível (kWh) */
  limits: Record<Severity, number>;
  /** envelope P99 × (1+tol) (kWh) */
  envelope: number;
  /** qual das 4 condições definiu o limite de cada nível */
  binding: Record<Severity, LimitBinding>;
  windowKey: string;
  windowName: string;
  dayType: DayType;
  baseline: BaselineSnapshot;
  rulesVersion: string;
}

function envelopeBase(b: BaselineStats, quantile: number): number {
  if (quantile >= 0.99) return b.p99;
  if (quantile >= 0.97) return b.p97;
  return b.p90;
}

export function snapshotBaseline(b: BaselineStats): BaselineSnapshot {
  return {
    windowKey: b.windowKey,
    dayType: b.dayType,
    n: b.n,
    median: b.median,
    sigmaRaw: b.sigma,
    p99: b.p99,
    quantum: b.quantum,
    from: b.from.toISOString(),
    to: b.to.toISOString(),
  };
}

export function evaluateValue(
  value: number,
  baseline: BaselineStats,
  window: OperationalWindow,
  dayType: DayType,
  rules: RuleSet,
  intervalMin: number
): Evaluation {
  const hours = intervalMin / 60;
  const median = baseline.median;
  const mult = window.thresholdMultiplier;

  const sigma = Math.max(
    baseline.sigma,
    rules.sigmaRelFloor * median,
    rules.sigmaAbsFloorKw * hours,
    baseline.quantum * 0.7
  );
  const minExcess = Math.max(rules.minExcessKw * hours, baseline.quantum * 2);
  const envelope = envelopeBase(baseline, rules.envelope.quantile) * (1 + rules.envelope.tolerance);

  const limits = {} as Record<Severity, number>;
  const binding = {} as Record<Severity, LimitBinding>;
  for (const sev of SEVERITIES) {
    const lv = rules.levels[sev];
    const candidates: [LimitBinding, number][] = [
      ['z', median + lv.z * mult * sigma],
      ['pct', median * (1 + lv.pct * mult)],
      ['min_excess', median + minExcess],
      ['envelope', envelope],
    ];
    const [which, limit] = candidates.reduce((best, c) => (c[1] > best[1] ? c : best));
    limits[sev] = limit;
    binding[sev] = which;
  }

  let level: Level = 'normal';
  for (const sev of [...SEVERITIES].reverse()) {
    if (value > limits[sev]) {
      level = sev;
      break;
    }
  }

  const excessKwh = Math.max(0, value - median);
  return {
    level,
    value,
    expected: median,
    sigma,
    z: sigma > 0 ? (value - median) / sigma : 0,
    pctOver: median > 0 ? (value - median) / median : value > 0 ? Number.POSITIVE_INFINITY : 0,
    excessKwh,
    limits,
    envelope,
    binding,
    windowKey: window.key,
    windowName: window.name,
    dayType,
    baseline: snapshotBaseline(baseline),
    rulesVersion: rules.version,
  };
}
