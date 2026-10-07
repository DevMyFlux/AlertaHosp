// Alertas (incidentes), linha do tempo e estado de persistência por setor.

import type { Queryable } from '../db.js';
import type { OpenAlertState, SectorState } from '../../../core/alerts/lifecycle.js';
import { initialSectorState } from '../../../core/alerts/lifecycle.js';
import type { ExplainPayload } from '../../../core/alerts/explain.js';
import type { Severity } from '../../../core/alerts/types.js';

type Row = Record<string, any>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string | Date));

export interface StoredAlert {
  id: number;
  unitId: number;
  sectorId: number;
  status: 'open' | 'recovered';
  windowKey: string;
  windowName: string;
  tariffBrlPerKwh: number;
  recoveredAt: Date | null;
  state: OpenAlertState;
}

function rowToStored(r: Row): StoredAlert {
  const severity = (r.severity ?? 'atencao') as Severity;
  return {
    id: Number(r.id),
    unitId: Number(r.unit_id),
    sectorId: Number(r.sector_id),
    status: r.status,
    windowKey: r.window_key,
    windowName: r.window_name,
    tariffBrlPerKwh: Number(r.tariff_brl_per_kwh),
    recoveredAt: date(r.recovered_at),
    state: {
      severity,
      peakSeverity: (r.peak_severity ?? severity) as Severity,
      openedAt: new Date(r.opened_at),
      severityChangedAt: new Date(r.severity_changed_at),
      lastBreachAt: new Date(r.last_breach_at),
      breachCount: num(r.breach_count),
      peakValueKwh: num(r.peak_value_kwh),
      peakPctOver: r.peak_pct_over === null ? Number.POSITIVE_INFINITY : num(r.peak_pct_over),
      baselineKwh: num(r.baseline_kwh),
      totalExcessKwh: num(r.total_excess_kwh),
      lastNotifiedAt: date(r.last_notified_at),
      lastNotifiedSeverity: (r.last_notified_severity ?? null) as Severity | null,
    },
  };
}

/** Alertas abertos da unidade, por setor. */
export async function loadOpenAlerts(q: Queryable, unitId: number): Promise<Map<number, StoredAlert>> {
  const res = await q.query<Row>("SELECT * FROM alerts WHERE unit_id = $1 AND status = 'open' AND origin = 'engine'", [unitId]);
  return new Map(res.rows.map(r => [Number(r.sector_id), rowToStored(r)]));
}

/** Último alerta recuperado de cada setor dentro da tolerância de reabertura. */
export async function loadRecentlyRecovered(q: Queryable, unitId: number, since: Date): Promise<Map<number, StoredAlert>> {
  const res = await q.query<Row>(
    `SELECT DISTINCT ON (sector_id) * FROM alerts
      WHERE unit_id = $1 AND status = 'recovered' AND origin = 'engine' AND recovered_at >= $2
      ORDER BY sector_id, recovered_at DESC`,
    [unitId, since]
  );
  return new Map(res.rows.map(r => [Number(r.sector_id), rowToStored(r)]));
}

export interface NewAlert {
  unitId: number;
  sectorId: number;
  windowKey: string;
  windowName: string;
  tariffBrlPerKwh: number;
  rulesVersion: string;
  state: OpenAlertState;
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

export async function insertAlert(q: Queryable, a: NewAlert): Promise<number> {
  const s = a.state;
  const res = await q.query<{ id: number }>(
    `INSERT INTO alerts (unit_id, sector_id, status, severity, peak_severity, window_key, window_name,
                         opened_at, severity_changed_at, last_breach_at, breach_count, peak_value_kwh,
                         baseline_kwh, peak_pct_over, total_excess_kwh, total_cost_brl, tariff_brl_per_kwh, rules_version)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      a.unitId, a.sectorId, s.severity, s.peakSeverity, a.windowKey, a.windowName,
      s.openedAt, s.severityChangedAt, s.lastBreachAt, s.breachCount, s.peakValueKwh,
      s.baselineKwh, finite(s.peakPctOver), s.totalExcessKwh, round2(s.totalExcessKwh * a.tariffBrlPerKwh),
      a.tariffBrlPerKwh, a.rulesVersion,
    ]
  );
  return Number(res.rows[0].id);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Grava o estado do alerta (aberto, reaberto ou recuperado). */
export async function saveAlertState(
  q: Queryable,
  id: number,
  state: OpenAlertState,
  tariffBrlPerKwh: number,
  recoveredAt: Date | null
): Promise<void> {
  await q.query(
    `UPDATE alerts
        SET status = $2, recovered_at = $3, severity = $4, peak_severity = $5, severity_changed_at = $6,
            last_breach_at = $7, breach_count = $8, peak_value_kwh = $9, baseline_kwh = $10, peak_pct_over = $11,
            total_excess_kwh = $12, total_cost_brl = $13, last_notified_at = $14, last_notified_severity = $15,
            updated_at = now()
      WHERE id = $1`,
    [
      id, recoveredAt ? 'recovered' : 'open', recoveredAt, state.severity, state.peakSeverity, state.severityChangedAt,
      state.lastBreachAt, state.breachCount, state.peakValueKwh, state.baselineKwh, finite(state.peakPctOver),
      state.totalExcessKwh, round2(state.totalExcessKwh * tariffBrlPerKwh), state.lastNotifiedAt, state.lastNotifiedSeverity,
    ]
  );
}

export interface NewEvent {
  type: 'opened' | 'reopened' | 'escalated' | 'breach' | 'recovered';
  ts: Date;
  severity: Severity | null;
  valueKwh: number | null;
  expectedKwh: number | null;
  limitKwh: number | null;
  z: number | null;
  pctOver: number | null;
  excessKwh: number | null;
  explain: ExplainPayload | Record<string, unknown>;
}

export async function insertEvents(q: Queryable, alertId: number, events: readonly NewEvent[]): Promise<void> {
  for (const e of events) {
    await q.query(
      `INSERT INTO alert_events (alert_id, type, ts, severity, value_kwh, expected_kwh, limit_kwh, z, pct_over, excess_kwh, explain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [alertId, e.type, e.ts, e.severity, e.valueKwh, e.expectedKwh, e.limitKwh, finite(e.z ?? NaN), finite(e.pctOver ?? NaN), e.excessKwh, JSON.stringify(e.explain)]
    );
  }
}

/** Ocorrências do setor nos últimos N dias (alertas do motor, exceto suspeitos), sem contar `excludeId`. */
export async function countRecentOccurrences(q: Queryable, sectorId: number, since: Date, excludeId: number): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int n FROM alerts WHERE sector_id = $1 AND opened_at >= $2 AND id <> $3 AND NOT suspect AND origin = 'engine'`,
    [sectorId, since, excludeId]
  );
  return res.rows[0].n;
}

// --- estado de persistência por setor (contadores antes de existir alerta) ---------------------------------

interface StoredSectorState {
  run: Record<Severity, number>;
  runStartedAt: string | null;
  runExcessKwh: number;
  normalStreak: number;
}

export async function loadSectorStates(q: Queryable, unitId: number): Promise<Map<number, StoredSectorState>> {
  const res = await q.query<{ sector_id: number; state: StoredSectorState }>(
    'SELECT ss.sector_id, ss.state FROM sector_state ss JOIN sectors s ON s.id = ss.sector_id WHERE s.unit_id = $1',
    [unitId]
  );
  return new Map(res.rows.map(r => [Number(r.sector_id), r.state]));
}

export function toSectorState(stored: StoredSectorState | undefined, open: StoredAlert | undefined, recent: StoredAlert | undefined): SectorState {
  const base = initialSectorState();
  if (stored) {
    base.run = { ...base.run, ...stored.run };
    base.runStartedAt = stored.runStartedAt ? new Date(stored.runStartedAt) : null;
    base.runExcessKwh = stored.runExcessKwh ?? 0;
    base.normalStreak = stored.normalStreak ?? 0;
  }
  base.open = open ? open.state : null;
  base.recentlyClosed = !open && recent?.recoveredAt ? { alert: recent.state, closedAt: recent.recoveredAt } : null;
  return base;
}

export async function saveSectorState(q: Queryable, sectorId: number, s: SectorState): Promise<void> {
  const payload: StoredSectorState = {
    run: s.run,
    runStartedAt: s.runStartedAt ? s.runStartedAt.toISOString() : null,
    runExcessKwh: s.runExcessKwh,
    normalStreak: s.normalStreak,
  };
  await q.query(
    `INSERT INTO sector_state (sector_id, state) VALUES ($1, $2::jsonb)
     ON CONFLICT (sector_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [sectorId, JSON.stringify(payload)]
  );
}
