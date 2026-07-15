// Módulo central de estatística — única fonte de verdade pra média, mediana,
// moda, dispersão e escolha automática da métrica mais representativa.
//
// Antes desta refatoração, três lugares diferentes calculavam estatística
// cada um do seu jeito: anomalyDetection.ts (mean + stdDev), ActiveAnomalies.tsx
// (mean + stdDev, mas com janela e limiar diferentes) e ImagingView.tsx
// (só mediana). Isso fazia a Visão Executiva mostrar anomalias diferentes do
// Monitoramento/AI Diagnostics pro mesmo instante. Esse módulo substitui os
// três, e é usado por eles (ver anomalyDetection.ts, ActiveAnomalies.tsx,
// ImagingView.tsx).

export function calcMean(vals: number[]): number {
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function calcMedian(sortedVals: number[]): number {
  if (!sortedVals.length) return 0;
  const mid = Math.floor(sortedVals.length / 2);
  return sortedVals.length % 2 !== 0
    ? sortedVals[mid]
    : (sortedVals[mid - 1] + sortedVals[mid]) / 2;
}

// Percentil por interpolação linear (método comum, mesmo usado por Excel/numpy
// "linear"). `p` de 0 a 100.
export function percentile(sortedVals: number[], p: number): number {
  if (!sortedVals.length) return 0;
  if (sortedVals.length === 1) return sortedVals[0];
  const idx = (p / 100) * (sortedVals.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedVals[lower];
  const frac = idx - lower;
  return sortedVals[lower] + (sortedVals[upper] - sortedVals[lower]) * frac;
}

export function calcStdDev(vals: number[], mean: number): number {
  if (!vals.length) return 0;
  const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
  return Math.sqrt(variance);
}

// Desvio absoluto mediano (MAD) — versão de "desvio-padrão" robusta a
// outliers, porque usa mediana em vez de média nas duas etapas. Multiplicado
// por 1,4826 (constante de consistência pra distribuição normal) fica na
// mesma escala que o desvio-padrão convencional, permitindo comparar/misturar
// os dois limiares.
export function calcMAD(vals: number[], median: number): number {
  if (!vals.length) return 0;
  const deviations = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  return calcMedian(deviations) * 1.4826;
}

// Moda pra dado contínuo (kWh raramente repete o valor exato) — agrupa em
// baldes (bucket) antes de contar frequência, e devolve o centro do balde
// mais frequente junto da proporção de leituras que caíram nele
// (`frequencyRatio`), usada pra decidir se o comportamento é "repetitivo" o
// bastante pra moda ser a métrica mais representativa.
export function calcMode(vals: number[], bucketSize = 1): { mode: number; frequencyRatio: number } {
  if (!vals.length) return { mode: 0, frequencyRatio: 0 };
  const buckets = new Map<number, number>();
  vals.forEach(v => {
    const key = Math.round(v / bucketSize) * bucketSize;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });
  let bestKey = vals[0];
  let bestCount = 0;
  buckets.forEach((count, key) => {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  });
  return { mode: bestKey, frequencyRatio: bestCount / vals.length };
}

// Assimetria de Pearson (coeficiente de assimetria momento-mediana):
// 3 * (média - mediana) / desvio-padrão. Perto de 0 = distribuição simétrica;
// valores altos (positivo ou negativo) = cauda longa de um lado (outliers
// puxando a média pra longe da mediana).
export function calcSkewness(mean: number, median: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (3 * (mean - median)) / stdDev;
}

// Proporção de leituras fora de 1,5×IQR (intervalo interquartil) — a mesma
// regra clássica de outlier de boxplot. Usada pra decidir se "tem muitos
// outliers" o bastante pra preferir mediana em vez de média.
export function calcOutlierRatio(sortedVals: number[]): number {
  if (sortedVals.length < 4) return 0;
  const q1 = percentile(sortedVals, 25);
  const q3 = percentile(sortedVals, 75);
  const iqr = q3 - q1;
  if (iqr === 0) return 0;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const outliers = sortedVals.filter(v => v < lower || v > upper).length;
  return outliers / sortedVals.length;
}

export type RepresentativeMetric = 'mean' | 'median' | 'mode';

// Escolhe automaticamente qual métrica melhor representa o comportamento
// "normal" de um conjunto de leituras, seguindo a regra pedida:
//   - comportamento repetitivo (mesmo valor/faixa aparece com muita
//     frequência) → moda;
//   - muitos outliers ou distribuição bem assimétrica → mediana (mais
//     robusta, não é puxada pelos extremos);
//   - caso contrário (dados razoavelmente simétricos, poucos outliers) →
//     média (mais eficiente estatisticamente quando não há distorção).
export function chooseRepresentativeMetric(params: {
  skewness: number;
  outlierRatio: number;
  modeFrequencyRatio: number;
}): RepresentativeMetric {
  const { skewness, outlierRatio, modeFrequencyRatio } = params;
  if (modeFrequencyRatio >= 0.3) return 'mode';
  if (outlierRatio > 0.05 || Math.abs(skewness) > 1) return 'median';
  return 'mean';
}

// Inclinação de uma regressão linear simples (mínimos quadrados) sobre uma
// série de valores igualmente espaçados no tempo — usada pra tendência
// (Etapa 5): positiva = subindo, negativa = caindo, perto de zero = estável.
// Normalizada pela média da série, então o resultado é "fração de variação
// por leitura", comparável entre setores com escalas de consumo diferentes.
export function calcTrendSlope(vals: number[]): number {
  const n = vals.length;
  if (n < 3) return 0;
  const xMean = (n - 1) / 2;
  const yMean = calcMean(vals);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (vals[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  if (den === 0 || yMean === 0) return 0;
  const slope = num / den;
  return slope / yMean; // normalizada
}

export interface DistributionStats {
  mean: number;
  median: number;
  mode: number;
  modeFrequencyRatio: number;
  stdDev: number;
  mad: number;
  min: number;
  max: number;
  skewness: number;
  outlierRatio: number;
  recommendedMetric: RepresentativeMetric;
  centralValue: number; // valor da métrica recomendada
  spread: number; // stdDev (se mean) ou MAD escalado (se median/mode) — dispersão na mesma unidade
  count: number;
}

// Função "tudo em um": recebe uma lista de leituras válidas (>0) de um
// setor/turno e devolve o pacote completo de estatísticas + a métrica
// escolhida automaticamente. Ponto único usado por anomalyDetection.ts,
// ActiveAnomalies.tsx e ImagingView.tsx.
export function analyzeDistribution(vals: number[], modeBucketSize = 1): DistributionStats {
  if (!vals.length) {
    return {
      mean: 0, median: 0, mode: 0, modeFrequencyRatio: 0, stdDev: 0, mad: 0,
      min: 0, max: 0, skewness: 0, outlierRatio: 0, recommendedMetric: 'mean',
      centralValue: 0, spread: 0, count: 0,
    };
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = calcMean(sorted);
  const median = calcMedian(sorted);
  const stdDev = calcStdDev(sorted, mean);
  const mad = calcMAD(sorted, median);
  const { mode, frequencyRatio: modeFrequencyRatio } = calcMode(sorted, modeBucketSize);
  const skewness = calcSkewness(mean, median, stdDev);
  const outlierRatio = calcOutlierRatio(sorted);
  const recommendedMetric = chooseRepresentativeMetric({ skewness, outlierRatio, modeFrequencyRatio });

  const centralValue = recommendedMetric === 'mean' ? mean : recommendedMetric === 'median' ? median : mode;
  const spread = recommendedMetric === 'mean' ? stdDev : (mad || stdDev); // MAD pode ser 0 com poucos dados; cai pra stdDev

  return {
    mean, median, mode, modeFrequencyRatio, stdDev, mad,
    min: sorted[0], max: sorted[sorted.length - 1],
    skewness, outlierRatio, recommendedMetric, centralValue, spread,
    count: sorted.length,
  };
}
