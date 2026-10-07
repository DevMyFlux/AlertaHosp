// Normalização de contadores acumulados em consumo por intervalo, com *quality gate*.
//
// Entrada: leituras cruas do totalizador (kWh acumulado) + qualidade OPC.
// Saída: uma `NormalizedReading` por setor/instante dizendo se o consumo do
// intervalo é confiável (`ok`/`gap`) ou não (`invalid`/`quarantined`/…), e por quê.
//
// Por que existe: a V1 fazia `valor(t) − valor(t−1)` e trocava qualquer problema
// por 0. Em 24/09/2026 o contador do HCN caiu para "-"/0 por UMA leitura (com
// Quality=192) e voltou; a leitura seguinte virou um "consumo" de 194.929 kWh,
// disparou 8 alertas de R$ 2,1 milhões e envenenou a base estatística.
//
// Regras (todas cobertas em tests/normalize.test.ts):
//   1. valor ausente/ilegível/negativo ou Quality ≠ 192 ⇒ `invalid` (não vira 0).
//   2. contador que REGREDIU ⇒ leitura suspeita (`counter_regression`). Fica
//      "pendente": se o contador voltar ao patamar anterior, era um glitch e a
//      leitura é descartada; se continuar subindo a partir do valor baixo, é um
//      reset real e o contador é re-baselinado.
//   3. regressão minúscula (ruído de medidor, ≤ 0,1%) ⇒ re-baseline sem consumo.
//   4. intervalo maior que o esperado (lacuna) ⇒ consumo normalizado pela taxa
//      (`gap`); lacuna longa demais ⇒ `stale_gap` (não avaliável).
//   5. vários setores com problema no mesmo instante ⇒ `source_event`
//      (reinício/queda da fonte) + período de estabilização em que as leituras
//      seguintes ficam em `quarantined` (guardadas, mas fora de baseline e alertas).

import type { RawSample } from './parse.js';
import { minutesBetween } from '../time.js';

export type ReadingStatus = 'baseline' | 'ok' | 'gap' | 'stale_gap' | 'quarantined' | 'invalid' | 'reset';

export type ReadingFlag =
  | 'null_value'
  | 'negative_value'
  | 'bad_quality'
  | 'counter_regression'
  | 'small_regression'
  | 'counter_reset'
  | 'glitch_discarded'
  | 'gap'
  | 'long_gap'
  | 'source_event'
  | 'stabilizing'
  | 'non_monotonic_time';

export interface NormalizedReading {
  sectorCode: string;
  ts: Date;
  counter: number | null;
  quality: number | null;
  status: ReadingStatus;
  /** energia bruta (kWh) desde a leitura de referência */
  deltaKwh: number | null;
  /** consumo normalizado para o intervalo esperado da unidade (kWh) */
  intervalKwh: number | null;
  /** minutos desde a leitura de referência */
  spanMinutes: number | null;
  flags: ReadingFlag[];
}

export interface SourceEvent {
  ts: Date;
  affectedSectors: number;
  totalSectors: number;
}

export interface NormalizeOptions {
  expectedIntervalMin: number;
  /** qualidade OPC considerada boa */
  goodQuality?: number;
  /** acima de expected × gapFactor a leitura é tratada como lacuna */
  gapFactor?: number;
  /** acima de expected × maxGapFactor a leitura não é avaliável */
  maxGapFactor?: number;
  /** regressão relativa tolerada como ruído de medidor */
  smallRegressionPct?: number;
  /** leituras postas em quarentena depois de um evento de fonte */
  stabilizationReadings?: number;
  /** nº mínimo de setores com problema simultâneo para configurar evento de fonte */
  sourceEventMinSectors?: number;
  /** fração mínima dos setores com problema simultâneo */
  sourceEventMinShare?: number;
}

export const DEFAULT_NORMALIZE_OPTIONS = {
  goodQuality: 192,
  gapFactor: 1.25,
  maxGapFactor: 3,
  smallRegressionPct: 0.001,
  stabilizationReadings: 2,
  sourceEventMinSectors: 3,
  sourceEventMinShare: 0.3,
} as const;

export interface NormalizeResult {
  /** todas as leituras, na ordem (timestamp, setor) */
  readings: NormalizedReading[];
  events: SourceEvent[];
}

const GLITCH_FLAGS: ReadonlySet<ReadingFlag> = new Set<ReadingFlag>([
  'null_value',
  'negative_value',
  'bad_quality',
  'counter_regression',
]);

interface Anchor {
  ts: Date;
  value: number;
}

function normalizeSector(
  sectorCode: string,
  samples: readonly RawSample[],
  opts: Required<NormalizeOptions>
): NormalizedReading[] {
  const out: NormalizedReading[] = [];
  let lastGood: Anchor | null = null;
  let pending: (Anchor & { index: number }) | null = null;

  samples.forEach((sample, i) => {
    const raw = sample.values[sectorCode] ?? { counter: null, quality: null };
    const r: NormalizedReading = {
      sectorCode,
      ts: sample.ts,
      counter: raw.counter,
      quality: raw.quality,
      status: 'invalid',
      deltaKwh: null,
      intervalKwh: null,
      spanMinutes: null,
      flags: [],
    };
    out.push(r);

    if (raw.counter === null) {
      r.flags.push('null_value');
      return;
    }
    if (raw.counter < 0) {
      r.flags.push('negative_value');
      return;
    }
    if (raw.quality !== null && raw.quality !== opts.goodQuality) {
      r.flags.push('bad_quality');
      return;
    }

    const value = raw.counter;
    if (!lastGood) {
      r.status = 'baseline';
      lastGood = { ts: sample.ts, value };
      return;
    }

    let span = minutesBetween(lastGood.ts, sample.ts);
    if (span <= 0) {
      r.flags.push('non_monotonic_time');
      return;
    }

    let delta = value - lastGood.value;

    if (delta < 0) {
      const drop = -delta;
      if (drop <= opts.smallRegressionPct * Math.abs(lastGood.value)) {
        // ruído de medidor: aceita o novo patamar, sem consumo atribuível
        r.flags.push('small_regression');
        lastGood = { ts: sample.ts, value };
        pending = null;
        return;
      }
      if (pending && value > pending.value) {
        // o contador recomeçou do valor baixo e está subindo: reset real
        const p = out[pending.index];
        p.status = 'reset';
        p.flags.push('counter_reset');
        lastGood = { ts: pending.ts, value: pending.value };
        pending = null;
        span = minutesBetween(lastGood.ts, sample.ts);
        delta = value - lastGood.value;
      } else {
        // suspeito: segura como pendente até ver o que vem depois
        pending = { ts: sample.ts, value, index: i };
        r.flags.push('counter_regression');
        return;
      }
    } else if (pending) {
      // o contador voltou ao patamar anterior: a queda era um glitch
      out[pending.index].flags.push('glitch_discarded');
      pending = null;
    }

    r.deltaKwh = delta;
    r.spanMinutes = span;

    if (span > opts.expectedIntervalMin * opts.maxGapFactor) {
      r.status = 'stale_gap';
      r.flags.push('long_gap');
    } else if (span > opts.expectedIntervalMin * opts.gapFactor) {
      r.status = 'gap';
      r.flags.push('gap');
      r.intervalKwh = (delta * opts.expectedIntervalMin) / span;
    } else {
      r.status = 'ok';
      r.intervalKwh = delta;
    }
    lastGood = { ts: sample.ts, value };
  });

  return out;
}

/**
 * Normaliza todas as leituras de uma unidade. `samples` deve estar em ordem
 * cronológica e sem timestamps repetidos (ver `parseSheetRows`).
 */
export function normalizeSamples(
  samples: readonly RawSample[],
  sectorCodes: readonly string[],
  options: NormalizeOptions
): NormalizeResult {
  const opts: Required<NormalizeOptions> = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
  const perSector = sectorCodes.map(code => normalizeSector(code, samples, opts));

  // --- passe de unidade: eventos de fonte + estabilização -----------------
  const events: SourceEvent[] = [];
  const total = sectorCodes.length;
  const threshold = Math.max(opts.sourceEventMinSectors, Math.ceil(opts.sourceEventMinShare * total));
  let quarantineLeft = 0;

  for (let i = 0; i < samples.length; i++) {
    const column = perSector.map(list => list[i]);
    const glitched = column.filter(r => r.flags.some(f => GLITCH_FLAGS.has(f)));
    const isEvent = total > 0 && glitched.length >= threshold;

    if (isEvent) {
      for (const r of glitched) r.flags.push('source_event');
      events.push({ ts: samples[i].ts, affectedSectors: glitched.length, totalSectors: total });
      quarantineLeft = opts.stabilizationReadings;
      continue;
    }
    if (quarantineLeft > 0) {
      for (const r of column) {
        if (r.status === 'ok' || r.status === 'gap' || r.status === 'stale_gap') {
          r.status = 'quarantined';
          r.flags.push('stabilizing');
        }
      }
      quarantineLeft--;
    }
  }

  const readings: NormalizedReading[] = [];
  for (let i = 0; i < samples.length; i++) for (const list of perSector) readings.push(list[i]);
  return { readings, events };
}

/** Leituras que podem compor baseline. */
export function isBaselineEligible(r: Pick<NormalizedReading, 'status' | 'intervalKwh'>): boolean {
  return r.status === 'ok' && r.intervalKwh !== null;
}

/** Leituras que podem ser avaliadas por regra de alerta. */
export function isEvaluable(r: Pick<NormalizedReading, 'status' | 'intervalKwh'>): boolean {
  return (r.status === 'ok' || r.status === 'gap') && r.intervalKwh !== null;
}
