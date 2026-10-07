// Estatística robusta usada pelo baseline e pelo detector.
//
// Escolha deliberada: mediana + MAD (desvio absoluto mediano) em vez de
// média + desvio-padrão. A V1 provou na prática (reinício de 24/09: um único
// valor de 195.000 kWh) que média/desvio são contaminados por um só ponto
// ruim; mediana/MAD toleram até 50% de outliers e são fáceis de explicar.

/** Fator que torna o MAD comparável a um desvio-padrão de distribuição normal. */
export const MAD_SCALE = 1.4826;

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Quantil com interpolação linear (mesmo método do numpy/Excel). `q` em [0,1]; `sorted` crescente. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function medianSorted(sorted: readonly number[]): number {
  return quantileSorted(sorted, 0.5);
}

export function median(values: readonly number[]): number {
  return medianSorted(sortedCopy(values));
}

/** MAD já multiplicado por MAD_SCALE (equivalente a um desvio-padrão robusto). */
export function scaledMad(values: readonly number[], center: number): number {
  if (values.length === 0) return 0;
  const deviations = values.map(v => Math.abs(v - center));
  return median(deviations) * MAD_SCALE;
}

export interface RobustSummary {
  n: number;
  median: number;
  /** desvio robusto (MAD × 1,4826) */
  sigma: number;
  mean: number;
  min: number;
  max: number;
  p10: number;
  p90: number;
  p97: number;
  p99: number;
}

export function summarize(values: readonly number[]): RobustSummary {
  const sorted = sortedCopy(values);
  const med = medianSorted(sorted);
  return {
    n: sorted.length,
    median: med,
    sigma: scaledMad(sorted, med),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p10: quantileSorted(sorted, 0.1),
    p90: quantileSorted(sorted, 0.9),
    p97: quantileSorted(sorted, 0.97),
    p99: quantileSorted(sorted, 0.99),
  };
}
