import { parseTimestamp } from '../time.js';
import type { UnitDef } from '../units.js';

export interface RawCounter {
  /** valor acumulado do totalizador (kWh); null = ausente/ilegível */
  counter: number | null;
  /** qualidade OPC (192 = boa); null = coluna ausente */
  quality: number | null;
}

export interface RawSample {
  ts: Date;
  /** por código canônico do setor */
  values: Record<string, RawCounter>;
}

/**
 * Converte o texto de uma célula em número. Aceita o formato do Google Sheets
 * em pt-BR ("254356,2969", "1.234,56") e o formato com ponto decimal. Devolve
 * `null` para vazio, "-", texto, NaN, Infinity — **nunca 0**: um zero inventado
 * foi o que gerou o delta de 195 mil kWh em 24/09.
 */
export function parseCounter(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (s === '' || s === '-') return null;
  let normalized = s;
  if (s.includes(',')) normalized = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function parseQuality(raw: unknown): number | null {
  const n = parseCounter(raw);
  return n === null ? null : Math.round(n);
}

export interface ParsedSheet {
  samples: RawSample[];
  /** linhas descartadas por timestamp inválido */
  rejectedRows: number;
  /** linhas repetidas (mesmo timestamp) — vale a última ocorrência */
  duplicateRows: number;
}

/**
 * Transforma as linhas do CSV da planilha (objetos coluna → texto) em amostras
 * tipadas, ordenadas e sem timestamps repetidos. A planilha insere no topo e
 * a ordem não é garantida, então ordenamos aqui.
 */
export function parseSheetRows(rows: Record<string, unknown>[], unit: UnitDef): ParsedSheet {
  const byTs = new Map<number, RawSample>();
  let rejectedRows = 0;
  let duplicateRows = 0;

  for (const row of rows) {
    const ts = parseTimestamp(String(row.E3TimeStamp ?? ''), unit.timezone);
    if (!ts) {
      rejectedRows++;
      continue;
    }
    const values: Record<string, RawCounter> = {};
    for (const s of unit.sectors) {
      const hasColumn = s.sourceColumn in row;
      values[s.code] = {
        counter: hasColumn ? parseCounter(row[s.sourceColumn]) : null,
        quality: parseQuality(row[`${s.sourceColumn}_Quality`]),
      };
    }
    const key = ts.getTime();
    if (byTs.has(key)) duplicateRows++;
    byTs.set(key, { ts, values });
  }

  const samples = [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return { samples, rejectedRows, duplicateRows };
}
