// Carrega telemetria exportada (CSV da planilha) e aplica a mesma normalização
// do servidor. Usado pelas ferramentas de análise/replay — nunca em produção.
import fs from 'node:fs';
import Papa from 'papaparse';
import { parseSheetRows } from '../../core/telemetry/parse.js';
import { normalizeSamples, type NormalizedReading, type SourceEvent } from '../../core/telemetry/normalize.js';
import { getUnit, type UnitCode, type UnitDef } from '../../core/units.js';

export interface LoadedUnit {
  unit: UnitDef;
  readings: NormalizedReading[];
  events: SourceEvent[];
  sampleCount: number;
  firstTs: Date;
  lastTs: Date;
}

export function loadUnitFromCsv(code: UnitCode, csvPath: string): LoadedUnit {
  const unit = getUnit(code);
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
  const { samples } = parseSheetRows(rows, unit);
  const { readings, events } = normalizeSamples(
    samples,
    unit.sectors.map(s => s.code),
    { expectedIntervalMin: unit.expectedIntervalMin }
  );
  return {
    unit,
    readings,
    events,
    sampleCount: samples.length,
    firstTs: samples[0].ts,
    lastTs: samples[samples.length - 1].ts,
  };
}
