// Importação do histórico da V1 (aba EstadoAlertas, via /api/alert-history) para
// a tabela `alerts`. Estratégia segura: nada é apagado nem alterado na origem;
// a importação é idempotente; linhas que são artefato conhecido (reset de
// contador) entram MARCADAS como suspeitas — preservadas para auditoria, mas
// fora dos totais.

import type { Queryable } from '../../backend/infra/db.js';
import { UNITS, type UnitCode, type UnitDef } from '../../core/units.js';
import type { SourceEvent } from '../../core/telemetry/normalize.js';

export interface LegacyRow {
  sectorKey: string;
  band: string;
  loggedAt: string;
  resolvedAt?: string;
  excedenteKwh?: number;
  custoGeradoBRL?: number;
  consumoMedido?: number;
  consumoReferencia?: number;
  percentualExcedente?: number;
}

export interface MappedLegacy {
  sectorCode: string;
  openedAt: Date;
  recoveredAt: Date;
  windowName: string;
  peakValueKwh: number;
  baselineKwh: number;
  peakPctOver: number | null;
  excessKwh: number;
  costBrl: number;
  suspect: boolean;
  suspectReason: string | null;
  payload: LegacyRow;
}

/** Excedente de UM intervalo acima disto é fisicamente impossível para estes medidores (máx. real observado ≈ 70 kWh). */
export const IMPLAUSIBLE_EXCESS_KWH = 1000;
/** Alertas gerados até esta janela depois de um reinício da fonte vêm do contador zerado. */
export const SOURCE_EVENT_WINDOW_MS = 60 * 60_000;

export function canonicalSectorCode(unit: UnitDef, legacyKey: string): string | null {
  const key = legacyKey.replace(/^\./, ''); // V1 gravava ".ME_CLIM_UTI" (ponto vem do tag SQL)
  return unit.sectors.some(s => s.code === key) ? key : null;
}

const finiteOr = (v: unknown, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

export function mapLegacyRow(unit: UnitDef, row: LegacyRow, sourceEvents: readonly SourceEvent[]): MappedLegacy | null {
  const sectorCode = canonicalSectorCode(unit, row.sectorKey);
  const opened = new Date(row.loggedAt);
  if (!sectorCode || Number.isNaN(opened.getTime())) return null;
  const resolved = row.resolvedAt ? new Date(row.resolvedAt) : null;
  const excess = finiteOr(row.excedenteKwh);

  let suspectReason: string | null = null;
  const nearEvent = sourceEvents.some(e => opened.getTime() >= e.ts.getTime() && opened.getTime() - e.ts.getTime() <= SOURCE_EVENT_WINDOW_MS);
  if (nearEvent && excess > 50) suspectReason = 'reset_de_contador (alerta logo após reinício da fonte)';
  else if (excess > IMPLAUSIBLE_EXCESS_KWH) suspectReason = 'excedente_implausivel (> 1.000 kWh em um intervalo)';

  return {
    sectorCode,
    openedAt: opened,
    recoveredAt: resolved && !Number.isNaN(resolved.getTime()) && resolved >= opened ? resolved : opened,
    windowName: row.band,
    peakValueKwh: finiteOr(row.consumoMedido),
    baselineKwh: finiteOr(row.consumoReferencia),
    peakPctOver: row.percentualExcedente ? finiteOr(row.percentualExcedente) / 100 : null,
    excessKwh: excess,
    costBrl: finiteOr(row.custoGeradoBRL),
    suspect: suspectReason !== null,
    suspectReason,
    payload: row,
  };
}

export interface LegacyReport {
  unit: UnitCode;
  received: number;
  mapped: number;
  skippedUnknownSector: number;
  inserted: number;
  alreadyPresent: number;
  suspect: number;
  /** soma na origem (todas as linhas mapeadas) × soma gravada: precisam bater */
  source: { excessKwh: number; costBrl: number };
  stored: { excessKwh: number; costBrl: number; suspectCostBrl: number; validCostBrl: number };
  reconciled: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function importLegacy(
  q: Queryable,
  unitCode: UnitCode,
  rows: readonly LegacyRow[],
  sourceEvents: readonly SourceEvent[]
): Promise<LegacyReport> {
  const unit = UNITS[unitCode];
  const u = await q.query<{ id: number; tariff_brl_per_kwh: number }>('SELECT id, tariff_brl_per_kwh FROM units WHERE code = $1', [unitCode]);
  if (u.rows.length === 0) throw new Error(`Unidade ${unitCode} não cadastrada (rode db:migrate)`);
  const sectors = await q.query<{ id: number; code: string }>('SELECT id, code FROM sectors WHERE unit_id = $1', [u.rows[0].id]);
  const sectorId = new Map(sectors.rows.map(s => [s.code, s.id]));

  const report: LegacyReport = {
    unit: unitCode, received: rows.length, mapped: 0, skippedUnknownSector: 0, inserted: 0, alreadyPresent: 0, suspect: 0,
    source: { excessKwh: 0, costBrl: 0 }, stored: { excessKwh: 0, costBrl: 0, suspectCostBrl: 0, validCostBrl: 0 }, reconciled: false,
  };

  for (const row of rows) {
    const m = mapLegacyRow(unit, row, sourceEvents);
    if (!m) {
      report.skippedUnknownSector++;
      continue;
    }
    report.mapped++;
    report.source.excessKwh += m.excessKwh;
    report.source.costBrl += m.costBrl;
    if (m.suspect) report.suspect++;
    const res = await q.query(
      `INSERT INTO alerts (unit_id, sector_id, status, severity, peak_severity, window_key, window_name, opened_at, severity_changed_at,
                           last_breach_at, recovered_at, breach_count, peak_value_kwh, baseline_kwh, peak_pct_over, total_excess_kwh,
                           total_cost_brl, tariff_brl_per_kwh, rules_version, notification_count, origin, suspect, suspect_reason, legacy_payload)
       VALUES ($1, $2, 'recovered', NULL, NULL, 'legacy', $3, $4, $4, $4, $5, 1, $6, $7, $8, $9, $10, $11, 'v1-legacy', 1, 'legacy_import', $12, $13, $14::jsonb)
       ON CONFLICT (sector_id, opened_at) WHERE origin = 'legacy_import' DO NOTHING`,
      [
        u.rows[0].id, sectorId.get(m.sectorCode), m.windowName, m.openedAt, m.recoveredAt, m.peakValueKwh, m.baselineKwh,
        m.peakPctOver, m.excessKwh, m.costBrl, u.rows[0].tariff_brl_per_kwh, m.suspect, m.suspectReason, JSON.stringify(m.payload),
      ]
    );
    if (res.rowCount === 1) report.inserted++;
    else report.alreadyPresent++;
  }

  // validação de integridade: o que está no banco para esta unidade tem de bater com a origem
  const stored = await q.query<{ n: number; excess: number; cost: number; suspect_cost: number; valid_cost: number }>(
    `SELECT count(*)::int n, COALESCE(sum(total_excess_kwh), 0) excess, COALESCE(sum(total_cost_brl), 0) cost,
            COALESCE(sum(total_cost_brl) FILTER (WHERE suspect), 0) suspect_cost,
            COALESCE(sum(total_cost_brl) FILTER (WHERE NOT suspect), 0) valid_cost
       FROM alerts WHERE unit_id = $1 AND origin = 'legacy_import'`,
    [u.rows[0].id]
  );
  const s = stored.rows[0];
  report.stored = { excessKwh: r2(Number(s.excess)), costBrl: r2(Number(s.cost)), suspectCostBrl: r2(Number(s.suspect_cost)), validCostBrl: r2(Number(s.valid_cost)) };
  report.source = { excessKwh: r2(report.source.excessKwh), costBrl: r2(report.source.costBrl) };
  // Contas fecham: tudo que chegou foi mapeado ou explicadamente descartado, tudo que foi mapeado
  // está gravado (agora ou numa execução anterior) e — numa carga limpa — os totais batem com a origem.
  const accounted = report.mapped + report.skippedUnknownSector === report.received && report.inserted + report.alreadyPresent === report.mapped;
  const totalsMatch = report.alreadyPresent > 0 || Math.abs(report.stored.costBrl - report.source.costBrl) < 0.05 * Math.max(1, report.mapped);
  report.reconciled = accounted && totalsMatch;
  return report;
}
