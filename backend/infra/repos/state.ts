// Estado do motor: cursor por unidade, saúde da fonte, eventos do sistema,
// execuções de ingestão e cache de baselines.

import type { Queryable } from '../db.js';
import type { BaselineSet, BaselineStats } from '../../../core/alerts/baseline.js';

export interface UnitStateRow {
  unitId: number;
  lastReadingTs: Date | null;
  lastEvaluatedTs: Date | null;
  sourceStatus: 'unknown' | 'online' | 'stale';
  sourceStatusChangedAt: Date | null;
  lastCycleAt: Date | null;
  lastCycleStatus: string | null;
  lastCycleSummary: Record<string, unknown> | null;
}

const d = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);

export async function loadUnitState(q: Queryable, unitId: number): Promise<UnitStateRow> {
  const res = await q.query<Record<string, any>>('SELECT * FROM unit_state WHERE unit_id = $1', [unitId]);
  const r = res.rows[0];
  if (!r) return { unitId, lastReadingTs: null, lastEvaluatedTs: null, sourceStatus: 'unknown', sourceStatusChangedAt: null, lastCycleAt: null, lastCycleStatus: null, lastCycleSummary: null };
  return {
    unitId,
    lastReadingTs: d(r.last_reading_ts),
    lastEvaluatedTs: d(r.last_evaluated_ts),
    sourceStatus: r.source_status,
    sourceStatusChangedAt: d(r.source_status_changed_at),
    lastCycleAt: d(r.last_cycle_at),
    lastCycleStatus: r.last_cycle_status,
    lastCycleSummary: r.last_cycle_summary,
  };
}

export async function saveUnitState(q: Queryable, unitId: number, patch: Partial<Omit<UnitStateRow, 'unitId'>>): Promise<void> {
  const cur = await loadUnitState(q, unitId);
  const next = { ...cur, ...patch };
  await q.query(
    `INSERT INTO unit_state (unit_id, last_reading_ts, last_evaluated_ts, source_status, source_status_changed_at,
                             last_cycle_at, last_cycle_status, last_cycle_summary, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
     ON CONFLICT (unit_id) DO UPDATE SET
       last_reading_ts = EXCLUDED.last_reading_ts, last_evaluated_ts = EXCLUDED.last_evaluated_ts,
       source_status = EXCLUDED.source_status, source_status_changed_at = EXCLUDED.source_status_changed_at,
       last_cycle_at = EXCLUDED.last_cycle_at, last_cycle_status = EXCLUDED.last_cycle_status,
       last_cycle_summary = EXCLUDED.last_cycle_summary, updated_at = now()`,
    [unitId, next.lastReadingTs, next.lastEvaluatedTs, next.sourceStatus, next.sourceStatusChangedAt, next.lastCycleAt, next.lastCycleStatus, next.lastCycleSummary ? JSON.stringify(next.lastCycleSummary) : null]
  );
}

export interface NewSystemEvent {
  unitId: number;
  ts: Date;
  kind: 'source_event' | 'source_stale' | 'source_resumed' | 'ingest_error';
  detail: Record<string, unknown>;
}

/** Idempotente: o mesmo (unidade, tipo, instante) só é registrado uma vez. */
export async function insertSystemEvent(q: Queryable, e: NewSystemEvent): Promise<boolean> {
  const res = await q.query(
    'INSERT INTO system_events (unit_id, ts, kind, detail) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (unit_id, kind, ts) DO NOTHING',
    [e.unitId, e.ts, e.kind, JSON.stringify(e.detail)]
  );
  return res.rowCount === 1;
}

export async function startIngestRun(q: Queryable, unitId: number, source: string): Promise<number> {
  const res = await q.query<{ id: number }>('INSERT INTO ingest_runs (unit_id, source) VALUES ($1, $2) RETURNING id', [unitId, source]);
  return Number(res.rows[0].id);
}

export async function finishIngestRun(
  q: Queryable,
  id: number,
  result: { status: 'ok' | 'error'; received?: number; fresh?: number; rejected?: number; error?: string }
): Promise<void> {
  await q.query(
    'UPDATE ingest_runs SET finished_at = now(), status = $2, rows_received = $3, rows_new = $4, rows_rejected = $5, error = $6 WHERE id = $1',
    [id, result.status, result.received ?? null, result.fresh ?? null, result.rejected ?? null, result.error?.slice(0, 500) ?? null]
  );
}

// --- cache de baselines ------------------------------------------------------------------------------

interface SerializedStats extends Omit<BaselineStats, 'from' | 'to'> {
  from: string;
  to: string;
}

export interface CachedBaselines {
  set: BaselineSet;
  asOf: Date;
  rulesVersion: string;
  computedAt: Date;
}

type BaselineRow = { sector_id?: number; as_of: Date; rules_version: string; stats: SerializedStats[]; computed_at: Date };

function toCached(r: BaselineRow): CachedBaselines {
  const set: BaselineSet = new Map();
  for (const s of r.stats) set.set(`${s.windowKey}:${s.dayType}`, { ...s, from: new Date(s.from), to: new Date(s.to) });
  return { set, asOf: new Date(r.as_of), rulesVersion: r.rules_version, computedAt: new Date(r.computed_at) };
}

export async function loadBaselineCache(q: Queryable, sectorId: number): Promise<CachedBaselines | null> {
  const res = await q.query<BaselineRow>('SELECT as_of, rules_version, stats, computed_at FROM sector_baselines WHERE sector_id = $1', [sectorId]);
  return res.rows[0] ? toCached(res.rows[0]) : null;
}

/** Baselines de TODOS os setores da unidade numa consulta só (evita N+1 nas telas). */
export async function loadUnitBaselines(q: Queryable, unitId: number): Promise<Map<number, CachedBaselines>> {
  const res = await q.query<BaselineRow & { sector_id: number }>(
    `SELECT b.sector_id, b.as_of, b.rules_version, b.stats, b.computed_at
       FROM sector_baselines b JOIN sectors s ON s.id = b.sector_id WHERE s.unit_id = $1`,
    [unitId]
  );
  return new Map(res.rows.map(r => [Number(r.sector_id), toCached(r)]));
}

export async function saveBaselineCache(q: Queryable, sectorId: number, set: BaselineSet, asOf: Date, rulesVersion: string): Promise<void> {
  const stats = [...set.values()].map(s => ({ ...s, from: s.from.toISOString(), to: s.to.toISOString() }));
  await q.query(
    `INSERT INTO sector_baselines (sector_id, as_of, rules_version, stats) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (sector_id) DO UPDATE SET as_of = EXCLUDED.as_of, rules_version = EXCLUDED.rules_version,
                                           stats = EXCLUDED.stats, computed_at = now()`,
    [sectorId, asOf, rulesVersion, JSON.stringify(stats)]
  );
}
