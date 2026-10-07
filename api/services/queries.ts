// Modelos de leitura do painel e dos relatórios. Toda consulta é escopada por
// unidade — não existe consulta "global" que misture HCN e HMB sem dizer a que
// unidade cada linha pertence.

import type { Queryable } from '../infra/db.js';
import type { UnitConfig } from '../infra/repos/config.js';
import type { UnitCode } from '../../core/units.js';
import type { Severity } from '../../core/alerts/types.js';
import { baselineForInstant, type BaselineContext } from '../../core/alerts/baseline.js';
import { evaluateValue } from '../../core/alerts/detector.js';
import { loadBaselineCache, loadUnitState } from '../infra/repos/state.js';
import { loadLatestReadings, loadSeries } from '../infra/repos/readings.js';

type Row = Record<string, any>;
const d = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ─── alertas ────────────────────────────────────────────────────────────────────────────────────

export interface AlertItem {
  id: number;
  unit: UnitCode;
  sectorCode: string;
  sectorName: string;
  kind: string;
  status: 'open' | 'recovered';
  severity: Severity | null;
  peakSeverity: Severity | null;
  windowName: string;
  openedAt: Date;
  recoveredAt: Date | null;
  durationMinutes: number;
  breachCount: number;
  peakValueKwh: number;
  baselineKwh: number;
  peakPctOver: number | null;
  totalExcessKwh: number;
  totalCostBrl: number;
  tariffBrlPerKwh: number;
  notificationCount: number;
  lastNotifiedAt: Date | null;
  origin: 'engine' | 'legacy_import';
  suspect: boolean;
  suspectReason: string | null;
}

export interface AlertFilter {
  unitId: number;
  from?: Date;
  to?: Date;
  status?: 'open' | 'recovered';
  severity?: Severity;
  sectorCode?: string;
  /** artefatos conhecidos (ex.: reset de contador importado do legado) ficam de fora dos totais por padrão */
  includeSuspect?: boolean;
  limit?: number;
  offset?: number;
}

const ALERT_SELECT = `
  SELECT a.*, u.code AS unit_code, s.code AS sector_code, s.name AS sector_name
    FROM alerts a
    JOIN units u ON u.id = a.unit_id
    JOIN sectors s ON s.id = a.sector_id AND s.unit_id = a.unit_id`;

function mapAlert(r: Row, now: Date): AlertItem {
  const opened = new Date(r.opened_at);
  const end = r.recovered_at ? new Date(r.recovered_at) : now; // alerta aberto: duração até agora
  return {
    id: n(r.id),
    unit: r.unit_code,
    sectorCode: r.sector_code,
    sectorName: r.sector_name,
    kind: r.kind,
    status: r.status,
    severity: r.severity,
    peakSeverity: r.peak_severity,
    windowName: r.window_name,
    openedAt: opened,
    recoveredAt: d(r.recovered_at),
    durationMinutes: Math.max(0, Math.round((end.getTime() - opened.getTime()) / 60000)),
    breachCount: n(r.breach_count),
    peakValueKwh: n(r.peak_value_kwh),
    baselineKwh: n(r.baseline_kwh),
    peakPctOver: r.peak_pct_over === null ? null : n(r.peak_pct_over),
    totalExcessKwh: n(r.total_excess_kwh),
    totalCostBrl: n(r.total_cost_brl),
    tariffBrlPerKwh: n(r.tariff_brl_per_kwh),
    notificationCount: n(r.notification_count),
    lastNotifiedAt: d(r.last_notified_at),
    origin: r.origin,
    suspect: !!r.suspect,
    suspectReason: r.suspect_reason,
  };
}

function alertWhere(f: AlertFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [f.unitId];
  const clauses = ['a.unit_id = $1'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (f.from) add('a.opened_at >= ?', f.from);
  if (f.to) add('a.opened_at < ?', f.to);
  if (f.status) add('a.status = ?', f.status);
  if (f.severity) add('a.peak_severity = ?', f.severity);
  if (f.sectorCode) add('s.code = ?', f.sectorCode);
  if (!f.includeSuspect) clauses.push('NOT a.suspect');
  return { where: clauses.join(' AND '), params };
}

export async function listAlerts(q: Queryable, f: AlertFilter, now: Date): Promise<{ items: AlertItem[]; total: number }> {
  const { where, params } = alertWhere(f);
  const total = await q.query<{ n: number }>(
    `SELECT count(*)::int n FROM alerts a JOIN sectors s ON s.id = a.sector_id WHERE ${where}`,
    params
  );
  const limit = f.limit ?? 50;
  const rows = await q.query<Row>(
    `${ALERT_SELECT} WHERE ${where} ORDER BY a.opened_at DESC, a.id DESC LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(f.offset ?? 0)}`,
    params
  );
  return { items: rows.rows.map(r => mapAlert(r, now)), total: total.rows[0].n };
}

export interface AlertEventItem {
  id: number;
  type: string;
  ts: Date;
  severity: Severity | null;
  valueKwh: number | null;
  expectedKwh: number | null;
  limitKwh: number | null;
  z: number | null;
  pctOver: number | null;
  excessKwh: number | null;
  explain: Record<string, any>;
}

export async function getAlertDetail(
  q: Queryable,
  id: number,
  now: Date
): Promise<{ alert: AlertItem; events: AlertEventItem[]; notifications: { id: number; status: string; createdAt: Date; reason: string }[] } | null> {
  const a = await q.query<Row>(`${ALERT_SELECT} WHERE a.id = $1`, [id]);
  if (a.rows.length === 0) return null;
  const events = await q.query<Row>('SELECT * FROM alert_events WHERE alert_id = $1 ORDER BY ts, id', [id]);
  const notifs = await q.query<Row>(
    `SELECT n.id, n.status, n.created_at, na.reason FROM notification_alerts na JOIN notifications n ON n.id = na.notification_id
      WHERE na.alert_id = $1 ORDER BY n.id`,
    [id]
  );
  return {
    alert: mapAlert(a.rows[0], now),
    events: events.rows.map(e => ({
      id: n(e.id), type: e.type, ts: new Date(e.ts), severity: e.severity,
      valueKwh: e.value_kwh, expectedKwh: e.expected_kwh, limitKwh: e.limit_kwh, z: e.z, pctOver: e.pct_over, excessKwh: e.excess_kwh,
      explain: e.explain ?? {},
    })),
    notifications: notifs.rows.map(x => ({ id: n(x.id), status: x.status, createdAt: new Date(x.created_at), reason: x.reason })),
  };
}

// ─── visão geral ────────────────────────────────────────────────────────────────────────────────

export interface Overview {
  unit: { code: UnitCode; name: string; intervalMin: number; timezone: string };
  period: { from: Date; to: Date; days: number };
  freshness: { lastReadingTs: Date | null; ageMinutes: number | null; sourceStatus: string; lastCycleAt: Date | null; lastCycleStatus: string | null };
  totals: { alerts: number; byPeak: Record<Severity, number>; excessKwh: number; costBrl: number; notificationsSent: number; openNow: number };
  openAlerts: AlertItem[];
  bySector: { sectorCode: string; sectorName: string; alerts: number; excessKwh: number; costBrl: number }[];
  byHour: { hour: number; alerts: number }[];
  consumption: { hour: string; kwh: number; coverage: number }[];
  sourceEvents: { ts: Date; kind: string; detail: Record<string, any> }[];
}

export async function getOverview(q: Queryable, cfg: UnitConfig, days: number, now: Date): Promise<Overview> {
  const from = new Date(now.getTime() - days * 86400000);
  const state = await loadUnitState(q, cfg.id);

  const totals = await q.query<Row>(
    `SELECT count(*)::int alerts,
            count(*) FILTER (WHERE peak_severity = 'atencao')::int atencao,
            count(*) FILTER (WHERE peak_severity = 'alto')::int alto,
            count(*) FILTER (WHERE peak_severity = 'critico')::int critico,
            COALESCE(sum(total_excess_kwh), 0) excess, COALESCE(sum(total_cost_brl), 0) cost
       FROM alerts WHERE unit_id = $1 AND opened_at >= $2 AND NOT suspect`,
    [cfg.id, from]
  );
  const sent = await q.query<{ n: number }>(
    "SELECT count(*)::int n FROM notifications WHERE unit_id = $1 AND created_at >= $2 AND status = 'sent'",
    [cfg.id, from]
  );
  const open = await listAlerts(q, { unitId: cfg.id, status: 'open', limit: 100, includeSuspect: false }, now);

  const bySector = await q.query<Row>(
    `SELECT s.code, s.name, count(*)::int alerts, COALESCE(sum(a.total_excess_kwh), 0) excess, COALESCE(sum(a.total_cost_brl), 0) cost
       FROM alerts a JOIN sectors s ON s.id = a.sector_id
      WHERE a.unit_id = $1 AND a.opened_at >= $2 AND NOT a.suspect
      GROUP BY s.code, s.name ORDER BY cost DESC, alerts DESC LIMIT 10`,
    [cfg.id, from]
  );
  const byHour = await q.query<Row>(
    `SELECT extract(hour FROM opened_at AT TIME ZONE $3)::int AS hour, count(*)::int alerts
       FROM alerts WHERE unit_id = $1 AND opened_at >= $2 AND NOT suspect GROUP BY 1 ORDER BY 1`,
    [cfg.id, from, cfg.timezone]
  );

  // consumo por hora (soma dos medidores monitorados; só leituras válidas)
  const trendFrom = new Date(now.getTime() - Math.min(days, 7) * 86400000);
  const trend = await q.query<Row>(
    `SELECT to_char(date_trunc('hour', r.ts AT TIME ZONE $3), 'YYYY-MM-DD"T"HH24:MI') AS hour,
            sum(r.interval_kwh) AS kwh, count(DISTINCT r.ts)::int AS samples
       FROM readings r JOIN sectors s ON s.id = r.sector_id
      WHERE r.unit_id = $1 AND r.ts >= $2 AND s.monitored AND r.status IN ('ok', 'gap') AND r.interval_kwh IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [cfg.id, trendFrom, cfg.timezone]
  );
  const perHour = 60 / cfg.expectedIntervalMin;

  const events = await q.query<Row>(
    "SELECT ts, kind, detail FROM system_events WHERE unit_id = $1 AND ts >= $2 AND kind <> 'ingest_error' ORDER BY ts DESC LIMIT 10",
    [cfg.id, from]
  );

  const lastReadingTs = state.lastReadingTs;
  const t = totals.rows[0];
  return {
    unit: { code: cfg.code, name: cfg.name, intervalMin: cfg.expectedIntervalMin, timezone: cfg.timezone },
    period: { from, to: now, days },
    freshness: {
      lastReadingTs,
      ageMinutes: lastReadingTs ? Math.round((now.getTime() - lastReadingTs.getTime()) / 60000) : null,
      sourceStatus: state.sourceStatus,
      lastCycleAt: state.lastCycleAt,
      lastCycleStatus: state.lastCycleStatus,
    },
    totals: {
      alerts: n(t.alerts),
      byPeak: { atencao: n(t.atencao), alto: n(t.alto), critico: n(t.critico) },
      excessKwh: n(t.excess),
      costBrl: n(t.cost),
      notificationsSent: sent.rows[0].n,
      openNow: open.total,
    },
    openAlerts: open.items,
    bySector: bySector.rows.map(r => ({ sectorCode: r.code, sectorName: r.name, alerts: n(r.alerts), excessKwh: n(r.excess), costBrl: n(r.cost) })),
    byHour: byHour.rows.map(r => ({ hour: n(r.hour), alerts: n(r.alerts) })),
    consumption: trend.rows.map(r => ({ hour: r.hour, kwh: n(r.kwh), coverage: Math.min(1, n(r.samples) / perHour) })),
    sourceEvents: events.rows.map(r => ({ ts: new Date(r.ts), kind: r.kind, detail: r.detail ?? {} })),
  };
}

// ─── setores agora ──────────────────────────────────────────────────────────────────────────────

export type SectorState = 'normal' | 'atencao' | 'alto' | 'critico' | 'learning' | 'no_data' | 'quarantine';

export interface SectorSnapshot {
  code: string;
  name: string;
  kind: string;
  monitored: boolean;
  state: SectorState;
  ts: Date | null;
  valueKwh: number | null;
  expectedKwh: number | null;
  pctOver: number | null;
  limits: Record<Severity, number> | null;
  window: string | null;
  baselineSamples: number | null;
  openAlertId: number | null;
  openSeverity: Severity | null;
  openedAt: Date | null;
  flags: string[];
}

export async function getSectorSnapshots(q: Queryable, cfg: UnitConfig, now: Date): Promise<SectorSnapshot[]> {
  const latest = new Map((await loadLatestReadings(q, cfg.id, new Date(now.getTime() - 3 * 86400000))).map(r => [r.sectorId, r]));
  const open = new Map(
    (await q.query<Row>("SELECT id, sector_id, severity, opened_at FROM alerts WHERE unit_id = $1 AND status = 'open' AND origin = 'engine'", [cfg.id])).rows.map(r => [n(r.sector_id), r])
  );
  const ctx: BaselineContext = { windows: cfg.windows, intervalMin: cfg.expectedIntervalMin, timeZone: cfg.timezone, rules: cfg.rules };
  const staleMs = Math.max(30, cfg.expectedIntervalMin * 3) * 60000;

  const out: SectorSnapshot[] = [];
  for (const s of cfg.sectors) {
    const lr = latest.get(s.id);
    const oa = open.get(s.id);
    const snap: SectorSnapshot = {
      code: s.code, name: s.name, kind: s.kind, monitored: s.monitored, state: 'no_data',
      ts: lr?.ts ?? null, valueKwh: lr?.intervalKwh ?? null, expectedKwh: null, pctOver: null, limits: null, window: null, baselineSamples: null,
      openAlertId: oa ? n(oa.id) : null, openSeverity: oa?.severity ?? null, openedAt: oa ? new Date(oa.opened_at) : null, flags: lr?.flags ?? [],
    };
    if (!s.monitored) {
      out.push(snap);
      continue;
    }
    if (!lr || now.getTime() - lr.ts.getTime() > staleMs) {
      out.push(snap);
      continue;
    }
    if (lr.status === 'quarantined') snap.state = 'quarantine';
    else if (lr.intervalKwh === null || (lr.status !== 'ok' && lr.status !== 'gap')) snap.state = 'no_data';
    else {
      const cache = await loadBaselineCache(q, s.id);
      const hit = cache ? baselineForInstant(cache.set, lr.ts, ctx) : null;
      if (!hit?.baseline) snap.state = 'learning';
      else {
        const ev = evaluateValue(lr.intervalKwh, hit.baseline, hit.window, hit.dayType, cfg.rules, cfg.expectedIntervalMin);
        snap.state = ev.level;
        snap.expectedKwh = ev.expected;
        snap.pctOver = Number.isFinite(ev.pctOver) ? ev.pctOver : null;
        snap.limits = ev.limits;
        snap.window = ev.windowName;
        snap.baselineSamples = ev.baseline.n;
      }
    }
    out.push(snap);
  }
  return out;
}

// ─── série de um setor (gráfico com faixa esperada) ────────────────────────────────────────────

export interface SeriesPointOut {
  ts: Date;
  kwh: number | null;
  status: string;
  expected: number | null;
  limitAtencao: number | null;
  limitAlto: number | null;
}

export async function getSectorSeries(q: Queryable, cfg: UnitConfig, sectorId: number, from: Date, to: Date): Promise<SeriesPointOut[]> {
  const points = await loadSeries(q, sectorId, from, to);
  const cache = await loadBaselineCache(q, sectorId);
  const ctx: BaselineContext = { windows: cfg.windows, intervalMin: cfg.expectedIntervalMin, timeZone: cfg.timezone, rules: cfg.rules };
  return points.map(p => {
    let expected: number | null = null;
    let limitAtencao: number | null = null;
    let limitAlto: number | null = null;
    if (cache) {
      const hit = baselineForInstant(cache.set, p.ts, ctx);
      if (hit?.baseline) {
        const ev = evaluateValue(hit.baseline.median, hit.baseline, hit.window, hit.dayType, cfg.rules, cfg.expectedIntervalMin);
        expected = ev.expected;
        limitAtencao = ev.limits.atencao;
        limitAlto = ev.limits.alto;
      }
    }
    return { ts: p.ts, kwh: p.intervalKwh, status: p.status, expected, limitAtencao, limitAlto };
  });
}

