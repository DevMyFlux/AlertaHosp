// Baseline robusto por setor × faixa operacional × tipo de dia.
//
// "Esperado" = mediana das leituras VÁLIDAS (status `ok`) dos últimos N dias na
// mesma faixa e tipo de dia; "variação normal" = MAD escalado. Leituras
// quarentenadas, inválidas ou com lacuna nunca entram — uma reinicialização da
// fonte não consegue mais mexer na média/mediana (incidente de 24/09).

import type { DayType } from '../time.js';
import { summarize, type RobustSummary } from '../stats.js';
import type { RuleSet } from './rules.js';
import { windowFor, type OperationalWindow } from './windows.js';

export interface BaselineStats extends RobustSummary {
  windowKey: string;
  dayType: DayType | 'all';
  /** 1 quando o contador só tem resolução inteira (kWh) — o menor degrau mensurável */
  quantum: number;
  /** primeiro e último instante de dados usados */
  from: Date;
  to: Date;
}

export interface BaselineSample {
  ts: Date;
  kwh: number;
  /** faixa/tipo de dia já resolvidos (otimização para backtest e cache) */
  windowKey?: string;
  dayType?: DayType;
}

export type BaselineSet = Map<string, BaselineStats>;

export interface BaselineContext {
  windows: readonly OperationalWindow[];
  intervalMin: number;
  timeZone: string;
  rules: RuleSet;
}

export function baselineKey(windowKey: string, dayType: DayType | 'all'): string {
  return `${windowKey}:${dayType}`;
}

function detectQuantum(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const integers = values.filter(v => Math.abs(v - Math.round(v)) < 1e-6).length;
  return integers / values.length >= 0.99 ? 1 : 0;
}

function toStats(
  windowKey: string,
  dayType: DayType | 'all',
  samples: BaselineSample[]
): BaselineStats {
  const values = samples.map(s => s.kwh);
  let from = samples[0].ts;
  let to = samples[0].ts;
  for (const s of samples) {
    if (s.ts < from) from = s.ts;
    if (s.ts > to) to = s.ts;
  }
  return { ...summarize(values), windowKey, dayType, quantum: detectQuantum(values), from, to };
}

/**
 * Constrói todos os baselines de um setor usando só amostras anteriores a
 * `asOf` (sem olhar o futuro) e dentro da janela de `lookbackDays`.
 */
export function buildBaselineSet(
  samples: readonly BaselineSample[],
  asOf: Date,
  ctx: BaselineContext
): BaselineSet {
  const since = asOf.getTime() - ctx.rules.lookbackDays * 86400000;
  const groups = new Map<string, BaselineSample[]>();
  const push = (key: string, s: BaselineSample) => {
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  };

  for (const s of samples) {
    const t = s.ts.getTime();
    if (t < since || t >= asOf.getTime()) continue;
    let windowKey = s.windowKey;
    let dayType = s.dayType;
    if (!windowKey || !dayType) {
      const hit = windowFor(ctx.windows, s.ts, ctx.intervalMin, ctx.timeZone);
      if (!hit) continue;
      windowKey = hit.window.key;
      dayType = hit.dayType;
    }
    push(baselineKey(windowKey, dayType), s);
    push(baselineKey(windowKey, 'all'), s);
  }

  const set: BaselineSet = new Map();
  for (const [key, list] of groups) {
    const [windowKey, dayType] = key.split(':') as [string, DayType | 'all'];
    set.set(key, toStats(windowKey, dayType, list));
  }
  return set;
}

/**
 * Escolhe o baseline aplicável: tipo de dia específico se tiver amostras
 * suficientes; senão o agregado da faixa; senão nenhum (setor "aprendendo").
 */
export function pickBaseline(
  set: BaselineSet,
  windowKey: string,
  dayType: DayType,
  minSamples: number
): BaselineStats | null {
  const specific = set.get(baselineKey(windowKey, dayType));
  if (specific && specific.n >= minSamples) return specific;
  const pooled = set.get(baselineKey(windowKey, 'all'));
  if (pooled && pooled.n >= minSamples) return pooled;
  return null;
}

/** Atalho: faixa e baseline aplicáveis a um instante. */
export function baselineForInstant(
  set: BaselineSet,
  ts: Date,
  ctx: BaselineContext
): { window: OperationalWindow; dayType: DayType; baseline: BaselineStats | null } | null {
  const hit = windowFor(ctx.windows, ts, ctx.intervalMin, ctx.timeZone);
  if (!hit) return null;
  return {
    window: hit.window,
    dayType: hit.dayType,
    baseline: pickBaseline(set, hit.window.key, hit.dayType, ctx.rules.minBaselineSamples),
  };
}

