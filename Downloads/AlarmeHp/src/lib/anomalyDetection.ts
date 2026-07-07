import { ProcessedTelemetryData, ALL_SECTORS } from '../types';

export type TimeBand = 'Café da Manhã (07-10h)' | 'Almoço (10-14h)' | 'Jantar (18-22h)' | 'Demais Horários';

export function getBand(hour: number): TimeBand {
  if (hour >= 7 && hour < 10) return 'Café da Manhã (07-10h)';
  if (hour >= 10 && hour < 14) return 'Almoço (10-14h)';
  if (hour >= 18 && hour < 22) return 'Jantar (18-22h)';
  return 'Demais Horários';
}

export const SECTOR_MAPPING: Record<string, { label: string; sub?: string; type: string }> = {
  'DJ1_Lavanderia': { label: 'Lavanderia', sub: 'ME_CLIM_LAVANDERIA', type: 'Infra' },
  'DJ7_Oncologia': { label: 'Oncologia', sub: 'ME_CLIM_ONC_A_T', type: 'Crítico' },
  'DJ13_Laboratorio': { label: 'Laboratório', sub: 'ME_CLIM_LABORATORIO', type: 'Crítico' },
  'DJ40_Refeitorio': { label: 'Refeitório', sub: 'ME_CLIM_REF', type: 'Infra' },
  'DJ50_CME': { label: 'CME', sub: 'ME_CLIM_CC_CO_CME', type: 'Crítico' },
  'SADT': { label: 'SADT', type: 'Crítico' },
  'ME_UTI_QG_E3': { label: 'UTI QG', sub: 'ME_CLIM_UTI', type: 'Crítico' },
  'ME_UTI_QD_IT': { label: 'UTI QD IT', sub: 'ME_CLIM_UTI', type: 'Crítico' },
  'DJ14_Radiologia': { label: 'Radiologia', type: 'Imagem' },
  'DJ60_RM': { label: 'Ressonância', type: 'Imagem' },
  'DJ61_Tomografia': { label: 'Tomografia', type: 'Imagem' },
  'DJ58_RX1': { label: 'Raios-X 1', type: 'Imagem' },
  'DJ59_RX2': { label: 'Raios-X 2', type: 'Imagem' }
};

export interface SectorStats {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
}

export function calcStats(vals: number[]): SectorStats {
  if (!vals.length) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { mean, median, stdDev, min, max };
}

// Constrói média/mediana/desvio-padrão por setor e turno (janela de horário),
// usando todo o histórico disponível — a mesma base estatística usada tanto
// pela análise pontual (LiveMonitorView) quanto pelo relatório histórico
// (DiagnosticsView), evitando que as duas telas divirjam nos critérios de
// anomalia.
export function buildSectorBandStats(data: ProcessedTelemetryData[]): Record<string, Record<TimeBand, SectorStats>> {
  const histData: Record<string, Record<TimeBand, number[]>> = {};
  ALL_SECTORS.forEach(sec => {
    histData[sec] = {
      'Café da Manhã (07-10h)': [],
      'Almoço (10-14h)': [],
      'Jantar (18-22h)': [],
      'Demais Horários': [],
    };
  });

  data.forEach(row => {
    const band = getBand(row.hour);
    ALL_SECTORS.forEach(sec => {
      const val = Number(row[sec]);
      if (!isNaN(val) && val > 0) {
        histData[sec][band].push(val);
      }
    });
  });

  const sStats: Record<string, Record<TimeBand, SectorStats>> = {};
  ALL_SECTORS.forEach(sec => {
    sStats[sec] = {} as Record<TimeBand, SectorStats>;
    (Object.keys(histData[sec]) as TimeBand[]).forEach(band => {
      sStats[sec][band] = calcStats(histData[sec][band]);
    });
  });

  return sStats;
}

export interface SectorAnomaly {
  date: string;
  time: string;
  band: TimeBand;
  sectorName: string;
  sectorKey: string;
  type: string;
  val: number;
  mean: number;
  expectedMax: number;
  deviation: number;
  severity: 'Moderado' | 'Alto' | 'Crítico';
  subVal: number;
  subMedian: number;
  subName: string;
}

// Avalia os setores conhecidos (SECTOR_MAPPING) em uma única linha de
// telemetria contra as estatísticas históricas do turno correspondente.
// Usado tanto para varrer várias linhas (histórico) quanto uma só (snapshot
// mais recente).
export function detectSectorAnomalies(
  row: ProcessedTelemetryData,
  sStats: Record<string, Record<TimeBand, SectorStats>>
): SectorAnomaly[] {
  const band = getBand(row.hour);
  const dateStr = row.timestamp.split(/[T ]/)[0];
  const anomalies: SectorAnomaly[] = [];

  Object.keys(SECTOR_MAPPING).forEach(sec => {
    const actualKey = ALL_SECTORS.find(k => k.includes(sec)) || sec;
    const val = Number(row[actualKey]);
    const s = sStats[actualKey]?.[band];

    if (!s || s.mean === 0) return;

    const upperLimit = s.mean + (1.5 * s.stdDev);

    if (val > upperLimit && val > 5) {
      const deviation = ((val - upperLimit) / upperLimit) * 100;
      if (deviation > 10) {
        let severity: SectorAnomaly['severity'] = 'Moderado';
        if (deviation > 50) severity = 'Crítico';
        else if (deviation > 20) severity = 'Alto';

        const mapInfo = SECTOR_MAPPING[sec];
        let subVal = 0;
        let subMedian = 1;
        let actualSubKey = '';

        if (mapInfo.sub) {
          actualSubKey = ALL_SECTORS.find(k => k.includes(mapInfo.sub!)) || mapInfo.sub;
          subVal = Number(row[actualSubKey]) || 0;
          subMedian = sStats[actualSubKey]?.[band]?.median || 1;
        }

        anomalies.push({
          date: dateStr,
          time: row.time,
          band,
          sectorName: mapInfo.label,
          sectorKey: actualKey,
          type: mapInfo.type,
          val,
          mean: s.mean,
          expectedMax: upperLimit,
          deviation,
          severity,
          subVal,
          subMedian,
          subName: actualSubKey,
        });
      }
    }
  });

  return anomalies;
}
