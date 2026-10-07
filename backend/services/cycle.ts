// Ciclo do motor, executado a cada ~15 min (e sob demanda):
//
//   buscar telemetria → gravar leituras (idempotente) → normalizar com quality
//   gate → avaliar só leituras novas, em ordem → atualizar alertas/linha do
//   tempo → política de notificação → fila → envio.
//
// Garantias:
//  • UM ciclo por unidade por vez (advisory lock) — dois gatilhos sobrepostos não
//    duplicam alerta (era o risco do Apps Script do HCN, sem lock).
//  • Cada leitura é avaliada exatamente uma vez (cursor `last_evaluated_ts`):
//    a mesma linha não gera dois alertas se o sync atrasar, e nada se perde se
//    um ciclo for pulado.
//  • Estado e fila são gravados na MESMA transação; o envio externo acontece
//    depois do commit e uma falha devolve o aviso à fila lógica (outbox).
//  • Fonte parada ou dado velho nunca gera aviso de consumo.

import type { Db, Queryable } from '../infra/db.js';
import type { Logger, Notifier, TelemetrySource } from '../infra/ports.js';
import { UNITS, type UnitCode } from '../../core/units.js';
import { parseSheetRows, type ParsedSheet } from '../../core/telemetry/parse.js';
import { normalizeSamples, DEFAULT_NORMALIZE_OPTIONS, isEvaluable } from '../../core/telemetry/normalize.js';
import { buildBaselineSet, baselineForInstant, type BaselineContext, type BaselineSet } from '../../core/alerts/baseline.js';
import { evaluateValue, type Evaluation } from '../../core/alerts/detector.js';
import { stepSector, type LifecycleEvent, type SectorState } from '../../core/alerts/lifecycle.js';
import { buildExplain } from '../../core/alerts/explain.js';
import { collectCandidates, planNotifications, type CycleSectorOutcome } from '../../core/alerts/policy.js';
import { buildSmsText, buildWhatsAppParams, type DigestItem } from '../../core/alerts/messages.js';
import { LEVEL_RANK, type Severity } from '../../core/alerts/types.js';
import { loadUnitConfig, type UnitConfig } from '../infra/repos/config.js';
import {
  findContextStart, loadRawSamples, loadReadingsAfter, loadBaselineSamples, upsertRawReadings, writeDerived, type RawRow,
} from '../infra/repos/readings.js';
import {
  countRecentOccurrences, insertAlert, insertEvents, loadOpenAlerts, loadRecentlyRecovered, loadSectorStates,
  saveAlertState, saveSectorState, toSectorState, type NewEvent, type StoredAlert,
} from '../infra/repos/alerts.js';
import {
  countSentSince, insertNotification, linkAlerts, loadQueued, loadStuckSending, markFailed, markSending, markSent,
} from '../infra/repos/notifications.js';
import {
  finishIngestRun, insertSystemEvent, loadBaselineCache, loadUnitState, saveBaselineCache, saveUnitState, startIngestRun,
} from '../infra/repos/state.js';

export interface CycleDeps {
  db: Db;
  source: TelemetrySource;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  /** avalia e grava, mas não envia (validação em paralelo ao motor antigo) */
  shadow: boolean;
}

export interface CycleOptions {
  /** linhas pedidas à fonte (padrão 300 ≈ 2–3 dias) */
  sheetLimit?: number | 'all';
  /** em backfill: avalia o histórico a partir daqui (padrão: só as últimas leituras) */
  evaluateFrom?: Date;
  /** false = grava alertas mas nunca enfileira mensagens (backfill) */
  notify?: boolean;
}

export interface CycleResult {
  unit: UnitCode;
  status: 'ok' | 'skipped' | 'error';
  skipped?: 'locked' | 'no_new_data';
  error?: string;
  ingest: { received: number; inserted: number; changed: number; rejected: number };
  normalize: { derivedUpdated: number; sourceEvents: number };
  evaluation: { readings: number; opened: number; reopened: number; escalated: number; recovered: number; breaches: number };
  notifications: { planned: number; queued: number; suppressed: number; deferred: number; sent: number; failed: number };
  source: { status: 'online' | 'stale'; lastReadingTs: string | null; ageMinutes: number | null };
  durationMs: number;
}

const DAY = 86400000;
const EVAL_CONTEXT_MAX_BACK = 3 * DAY;
const BASELINE_REFRESH_MS = 6 * 3600000;

function emptyResult(unit: UnitCode): CycleResult {
  return {
    unit,
    status: 'ok',
    ingest: { received: 0, inserted: 0, changed: 0, rejected: 0 },
    normalize: { derivedUpdated: 0, sourceEvents: 0 },
    evaluation: { readings: 0, opened: 0, reopened: 0, escalated: 0, recovered: 0, breaches: 0 },
    notifications: { planned: 0, queued: 0, suppressed: 0, deferred: 0, sent: 0, failed: 0 },
    source: { status: 'online', lastReadingTs: null, ageMinutes: null },
    durationMs: 0,
  };
}

export async function runCycle(deps: CycleDeps, unitCode: UnitCode, options: CycleOptions = {}): Promise<CycleResult> {
  const started = deps.now();
  const unit = UNITS[unitCode];
  const cfg = await loadUnitConfig(deps.db, unitCode);
  const result = emptyResult(unitCode);

  // 1) telemetria (rede, fora de transação); pede mais linhas se houver "buraco" desde o último ciclo
  const state0 = await loadUnitState(deps.db, cfg.id);
  const runId = await startIngestRun(deps.db, cfg.id, 'sheet');
  let parsed: ParsedSheet;
  try {
    // sem dados no banco ⇒ primeira carga baixa a planilha inteira; depois só as linhas mais recentes
    let limit: number | 'all' = options.sheetLimit ?? (state0.lastReadingTs ? 300 : 'all');
    let rows = await deps.source.fetchRows(unit, limit);
    parsed = parseSheetRows(rows, unit);
    const oldestInPage = parsed.samples[0]?.ts;
    const hole = state0.lastReadingTs && oldestInPage && limit !== 'all' && oldestInPage.getTime() > state0.lastReadingTs.getTime() + cfg.expectedIntervalMin * 2 * 60000;
    if (hole) {
      deps.log.warn('ingest.gap_refetch', { unit: unitCode, lastReadingTs: state0.lastReadingTs, oldestInPage });
      limit = 5000;
      rows = await deps.source.fetchRows(unit, limit);
      parsed = parseSheetRows(rows, unit);
    }
    result.ingest.received = parsed.samples.length;
    result.ingest.rejected = parsed.rejectedRows;
    if (parsed.rejectedRows > 0) deps.log.warn('ingest.rejected_rows', { unit: unitCode, rejected: parsed.rejectedRows });
  } catch (error: any) {
    await finishIngestRun(deps.db, runId, { status: 'error', error: error?.message ?? String(error) });
    deps.log.error('ingest.error', { unit: unitCode, error: error?.message ?? String(error) });
    await deps.db.transaction(async tx => {
      await insertSystemEvent(tx, { unitId: cfg.id, ts: deps.now(), kind: 'ingest_error', detail: { error: String(error?.message ?? error).slice(0, 300) } });
      await saveUnitState(tx, cfg.id, { lastCycleAt: deps.now(), lastCycleStatus: 'ingest_error', lastCycleSummary: { error: String(error?.message ?? error).slice(0, 300) } });
    });
    result.status = 'error';
    result.error = `Falha ao obter a telemetria: ${error?.message ?? error}`;
    result.durationMs = deps.now().getTime() - started.getTime();
    return result;
  }

  // 2) gravação + normalização + avaliação (uma transação, uma unidade por vez)
  const outcome = await deps.db.transaction(tx => processInTransaction(tx, deps, cfg, parsed, result, options));
  if (outcome === 'locked') {
    await finishIngestRun(deps.db, runId, { status: 'ok', received: result.ingest.received, fresh: 0, rejected: result.ingest.rejected });
    result.status = 'skipped';
    result.skipped = 'locked';
    deps.log.info('cycle.skipped', { unit: unitCode, reason: 'locked' });
    result.durationMs = deps.now().getTime() - started.getTime();
    return result;
  }
  await finishIngestRun(deps.db, runId, { status: 'ok', received: result.ingest.received, fresh: result.ingest.inserted, rejected: result.ingest.rejected });

  // 3) envio das mensagens enfileiradas (rede, fora da transação)
  const delivery = await deliverQueued(deps, cfg);
  result.notifications.sent = delivery.sent;
  result.notifications.failed = delivery.failed;

  result.durationMs = deps.now().getTime() - started.getTime();
  deps.log.info('cycle.done', { unit: unitCode, status: result.status, skipped: result.skipped, ingest: result.ingest, evaluation: result.evaluation, notifications: result.notifications, source: result.source, durationMs: result.durationMs });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

async function processInTransaction(
  tx: Queryable,
  deps: CycleDeps,
  cfg: UnitConfig,
  parsed: ParsedSheet,
  result: CycleResult,
  options: CycleOptions
): Promise<'done' | 'locked'> {
  const lock = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`cycle:${cfg.code}`]);
  if (!lock.rows[0]?.ok) return 'locked';

  const now = deps.now();
  const interval = cfg.expectedIntervalMin;
  const sectorIdByCode = new Map(cfg.sectors.map(s => [s.code, s.id]));
  const monitored = cfg.sectors.filter(s => s.monitored);
  const state = await loadUnitState(tx, cfg.id);

  // --- gravação idempotente das leituras cruas ---------------------------------------------------
  const raw: RawRow[] = [];
  for (const sample of parsed.samples) {
    for (const [code, v] of Object.entries(sample.values)) {
      const sectorId = sectorIdByCode.get(code);
      if (sectorId !== undefined) raw.push({ sectorId, ts: sample.ts, counter: v.counter, quality: v.quality });
    }
  }
  const up = await upsertRawReadings(tx, cfg.id, raw, 'sheet');
  result.ingest.inserted = up.inserted;
  result.ingest.changed = up.changed;

  // --- saúde da fonte -----------------------------------------------------------------------------
  const newestTs = parsed.samples.length ? parsed.samples[parsed.samples.length - 1].ts : state.lastReadingTs;
  const ageMin = newestTs ? (now.getTime() - newestTs.getTime()) / 60000 : null;
  const staleAfter = Math.max(30, interval * 3);
  const stale = ageMin === null || ageMin > staleAfter;
  result.source = { status: stale ? 'stale' : 'online', lastReadingTs: newestTs?.toISOString() ?? null, ageMinutes: ageMin === null ? null : Math.round(ageMin) };
  if (stale && state.sourceStatus !== 'stale') {
    deps.log.warn('source.stale', { unit: cfg.code, ageMinutes: result.source.ageMinutes, lastReadingTs: newestTs });
    await insertSystemEvent(tx, { unitId: cfg.id, ts: newestTs ?? now, kind: 'source_stale', detail: { ageMinutes: result.source.ageMinutes } });
  } else if (!stale && state.sourceStatus === 'stale') {
    deps.log.info('source.resumed', { unit: cfg.code });
    await insertSystemEvent(tx, { unitId: cfg.id, ts: newestTs ?? now, kind: 'source_resumed', detail: {} });
  }
  const sourceStatus = stale ? 'stale' : 'online';
  const sourceChangedAt = sourceStatus !== state.sourceStatus ? now : state.sourceStatusChangedAt;

  if (up.inserted + up.changed === 0 || !up.firstChangedTs) {
    await saveUnitState(tx, cfg.id, {
      lastReadingTs: newestTs ?? state.lastReadingTs,
      sourceStatus, sourceStatusChangedAt: sourceChangedAt,
      lastCycleAt: now, lastCycleStatus: 'no_new_data', lastCycleSummary: { source: result.source },
    });
    result.status = 'skipped';
    result.skipped = 'no_new_data';
    return 'done';
  }

  // --- normalização com quality gate ---------------------------------------------------------------
  const norm = DEFAULT_NORMALIZE_OPTIONS;
  const contextStart = await findContextStart(tx, cfg.id, up.firstChangedTs, norm.stabilizationReadings + 2, EVAL_CONTEXT_MAX_BACK);
  const samples = await loadRawSamples(tx, cfg.id, contextStart, cfg.sectors);
  const normalized = normalizeSamples(samples, cfg.sectors.map(s => s.code), { expectedIntervalMin: interval });
  // Só grava o que é novo/alterado: as primeiras leituras do contexto não têm a leitura anterior e sairiam
  // como "baseline" — sobrescrever o que já estava correto no banco corromperia o histórico.
  const fromTs = up.firstChangedTs.getTime();
  result.normalize.derivedUpdated = await writeDerived(tx, cfg.id, normalized.readings.filter(r => r.ts.getTime() >= fromTs), sectorIdByCode);
  for (const ev of normalized.events) {
    const fresh = await insertSystemEvent(tx, { unitId: cfg.id, ts: ev.ts, kind: 'source_event', detail: { affectedSectors: ev.affectedSectors, totalSectors: ev.totalSectors } });
    if (fresh) {
      result.normalize.sourceEvents++;
      deps.log.warn('source.event_detected', { unit: cfg.code, ts: ev.ts, affectedSectors: ev.affectedSectors, totalSectors: ev.totalSectors });
    }
  }
  const rejectedReadings = normalized.readings.filter(r => r.status === 'invalid' && r.ts >= up.firstChangedTs!).length;
  if (rejectedReadings > 0) deps.log.warn('ingest.readings_rejected', { unit: cfg.code, count: rejectedReadings });

  // --- avaliação só do que é novo -------------------------------------------------------------------
  const lastTs = samples.length ? samples[samples.length - 1].ts : (newestTs as Date);
  let cursor = state.lastEvaluatedTs;
  if (options.evaluateFrom) cursor = new Date(options.evaluateFrom.getTime() - 1);
  else if (!cursor) cursor = new Date(lastTs.getTime() - interval * 60000 * 2 - 1); // 1º ciclo: só as 2 últimas leituras
  const toEvaluate = await loadReadingsAfter(tx, cfg.id, cursor, lastTs);
  const bySector = new Map<number, typeof toEvaluate>();
  for (const r of toEvaluate) {
    const list = bySector.get(r.sectorId);
    if (list) list.push(r);
    else bySector.set(r.sectorId, [r]);
  }

  const openAlerts = await loadOpenAlerts(tx, cfg.id);
  const recent = await loadRecentlyRecovered(tx, cfg.id, new Date((options.evaluateFrom ?? cursor).getTime() - cfg.rules.reopenGraceMinutes * 60000));
  const storedStates = await loadSectorStates(tx, cfg.id);
  const alertIds = new Map<number, number>([...openAlerts].map(([sid, a]) => [sid, a.id]));
  const recentIds = new Map<number, number>([...recent].map(([sid, a]) => [sid, a.id]));
  const ctx: BaselineContext = { windows: cfg.windows, intervalMin: interval, timeZone: cfg.timezone, rules: cfg.rules };
  const baselineMemo = new Map<number, { set: BaselineSet; asOf: Date; rulesVersion: string }>();

  const normByKey = new Map(normalized.readings.map(n => [`${n.sectorCode}|${n.ts.getTime()}`, n]));
  const outcomes: CycleSectorOutcome[] = [];
  const lastLevel = new Map<string, Evaluation | null>();
  let latestEvaluatedTs = null as Date | null;

  for (const sector of monitored) {
    const readings = bySector.get(sector.id) ?? [];
    let sstate: SectorState = toSectorState(storedStates.get(sector.id), openAlerts.get(sector.id), recent.get(sector.id));
    const cycleEvents: LifecycleEvent[] = [];
    let closed: SectorState['open'] = null;
    let lastExcess = 0;

    for (const r of readings) {
      latestEvaluatedTs = !latestEvaluatedTs || r.ts > latestEvaluatedTs ? r.ts : latestEvaluatedTs;
      result.evaluation.readings++;
      // valores recém-normalizados têm prioridade; fora do contexto vale o que já está no banco
      const n1 = normByKey.get(`${sector.code}|${r.ts.getTime()}`);
      const kwh = n1 ? n1.intervalKwh : r.intervalKwh;
      const evaluable = n1 ? isEvaluable(n1) : (r.status === 'ok' || r.status === 'gap') && r.intervalKwh !== null;
      let evaluation: Evaluation | null = null;
      if (evaluable && kwh !== null) {
        const set = await baselineFor(tx, cfg, sector.id, r.ts, ctx, baselineMemo);
        const hit = baselineForInstant(set, r.ts, ctx);
        if (hit?.baseline) evaluation = evaluateValue(kwh, hit.baseline, hit.window, hit.dayType, cfg.rules, interval);
      }
      if (evaluation) {
        lastLevel.set(sector.code, evaluation);
        lastExcess = evaluation.excessKwh;
      }

      const step = stepSector(sstate, r.ts, evaluation, cfg.rules);
      sstate = step.state;
      if (step.events.length === 0 || !evaluation) continue;
      cycleEvents.push(...step.events);
      for (const e of step.events) {
        if (e.type === 'opened') result.evaluation.opened++;
        else if (e.type === 'reopened') result.evaluation.reopened++;
        else if (e.type === 'escalated') result.evaluation.escalated++;
        else if (e.type === 'recovered') { result.evaluation.recovered++; closed = e.alert; }
        else result.evaluation.breaches++;
      }
      await persistAlertStep(tx, deps, cfg, sector.id, r.ts, evaluation, step.events, sstate, alertIds, recentIds);
    }

    await saveSectorState(tx, sector.id, sstate);
    outcomes.push({ sectorCode: sector.code, events: cycleEvents, open: sstate.open, closedAlert: closed, lastExcessKwh: lastExcess });
    if (!sstate.open) alertIds.delete(sector.id);
  }

  // --- política de notificação ----------------------------------------------------------------------
  if (options.notify !== false && !stale && latestEvaluatedTs) {
    await planAndQueueNotifications(tx, deps, cfg, outcomes, lastLevel, alertIds, recentIds, latestEvaluatedTs, now, result);
  }

  await saveUnitState(tx, cfg.id, {
    lastReadingTs: newestTs,
    lastEvaluatedTs: latestEvaluatedTs ?? state.lastEvaluatedTs ?? cursor,
    sourceStatus, sourceStatusChangedAt: sourceChangedAt,
    lastCycleAt: now, lastCycleStatus: 'ok',
    lastCycleSummary: { ingest: result.ingest, evaluation: result.evaluation, notifications: result.notifications, source: result.source },
  });
  return 'done';
}

async function baselineFor(
  tx: Queryable,
  cfg: UnitConfig,
  sectorId: number,
  ts: Date,
  ctx: BaselineContext,
  memo: Map<number, { set: BaselineSet; asOf: Date; rulesVersion: string }>
): Promise<BaselineSet> {
  const fresh = (c: { asOf: Date; rulesVersion: string }) =>
    c.rulesVersion === cfg.rules.version && ts.getTime() >= c.asOf.getTime() && ts.getTime() - c.asOf.getTime() <= BASELINE_REFRESH_MS;
  let cached = memo.get(sectorId);
  if (!cached) {
    const stored = await loadBaselineCache(tx, sectorId);
    if (stored) cached = { set: stored.set, asOf: stored.asOf, rulesVersion: stored.rulesVersion };
  }
  if (cached && fresh(cached)) {
    memo.set(sectorId, cached);
    return cached.set;
  }
  const samples = await loadBaselineSamples(tx, sectorId, new Date(ts.getTime() - cfg.rules.lookbackDays * DAY), ts);
  const set = buildBaselineSet(samples, ts, ctx);
  await saveBaselineCache(tx, sectorId, set, ts, cfg.rules.version);
  const next = { set, asOf: ts, rulesVersion: cfg.rules.version };
  memo.set(sectorId, next);
  return set;
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** Aplica no banco o que aconteceu com o alerta do setor nesta leitura (alerta + linha do tempo explicável). */
async function persistAlertStep(
  tx: Queryable,
  deps: CycleDeps,
  cfg: UnitConfig,
  sectorId: number,
  ts: Date,
  evaluation: Evaluation,
  events: readonly LifecycleEvent[],
  sstate: SectorState,
  alertIds: Map<number, number>,
  recentIds: Map<number, number>
): Promise<void> {
  const tariff = cfg.tariffBrlPerKwh;
  const rows: NewEvent[] = [];
  const toRow = (type: NewEvent['type'], severity: Severity | null, ev: Evaluation): NewEvent => {
    const level = severity ?? (ev.level === 'normal' ? 'atencao' : ev.level);
    return {
      type, ts, severity,
      valueKwh: ev.value, expectedKwh: ev.expected, limitKwh: ev.limits[level],
      z: finite(ev.z), pctOver: finite(ev.pctOver), excessKwh: ev.excessKwh,
      explain: buildExplain(ev, { required: cfg.rules.levels[level].persistence, observed: sstate.run[level] }),
    };
  };

  for (const e of events) {
    if (e.type === 'opened' && sstate.open) {
      const id = await insertAlert(tx, { unitId: cfg.id, sectorId, windowKey: evaluation.windowKey, windowName: evaluation.windowName, tariffBrlPerKwh: tariff, rulesVersion: cfg.rules.version, state: sstate.open });
      alertIds.set(sectorId, id);
      rows.push(toRow('opened', e.severity, e.evaluation));
      deps.log.info('alert.opened', { unit: cfg.code, sectorId, alertId: id, severity: e.severity, value: e.evaluation.value, expected: e.evaluation.expected });
    } else if (e.type === 'reopened') {
      const id = recentIds.get(sectorId);
      if (id) alertIds.set(sectorId, id);
      rows.push(toRow('reopened', e.severity, e.evaluation));
      deps.log.info('alert.reopened', { unit: cfg.code, sectorId, alertId: id });
    } else if (e.type === 'escalated') {
      rows.push(toRow('escalated', e.to, e.evaluation));
      deps.log.info('alert.escalated', { unit: cfg.code, sectorId, from: e.from, to: e.to, reason: e.reason });
    } else if (e.type === 'breach') {
      rows.push(toRow('breach', e.severity, e.evaluation));
    } else if (e.type === 'recovered') {
      const id = alertIds.get(sectorId);
      if (id) {
        await saveAlertState(tx, id, e.alert, tariff, ts);
        recentIds.set(sectorId, id);
        await insertEvents(tx, id, [toRow('recovered', null, e.evaluation)]);
        deps.log.info('alert.recovered', { unit: cfg.code, sectorId, alertId: id, durationMinutes: Math.round(e.durationMinutes) });
      }
    }
  }

  const id = alertIds.get(sectorId);
  if (id && sstate.open) {
    await saveAlertState(tx, id, sstate.open, tariff, null);
    if (rows.length) await insertEvents(tx, id, rows);
  }
}

async function planAndQueueNotifications(
  tx: Queryable,
  deps: CycleDeps,
  cfg: UnitConfig,
  outcomes: CycleSectorOutcome[],
  lastLevel: Map<string, Evaluation | null>,
  alertIds: Map<number, number>,
  recentIds: Map<number, number>,
  latestReadingTs: Date,
  now: Date,
  result: CycleResult
): Promise<void> {
  const candidates = collectCandidates(outcomes, cfg.policy, now, latestReadingTs);
  if (candidates.length === 0) return;
  const sentLastHour = await countSentSince(tx, cfg.id, new Date(now.getTime() - 3600000));
  const plan = planNotifications(candidates, cfg.policy, sentLastHour);
  result.notifications.planned = candidates.length;
  if (plan.send.length === 0) {
    result.notifications.deferred = plan.deferred.length;
    deps.log.warn('alert.suppressed', { unit: cfg.code, reason: plan.reason, deferred: plan.deferred.map(c => c.sectorCode) });
    return;
  }

  const sectorByCode = new Map(cfg.sectors.map(s => [s.code, s]));
  const windowHours = (key: string) => {
    const w = cfg.windows.find(x => x.key === key);
    return w ? (w.endMin - w.startMin) / 60 : 4;
  };
  const items: DigestItem[] = [];
  const links: { alertId: number; reason: (typeof plan.send)[number]['reason']; prevAt: Date | null; prevSev: Severity | null; sector: string }[] = [];
  for (const c of plan.send) {
    const sector = sectorByCode.get(c.sectorCode)!;
    const alertId = c.reason === 'recovered' ? recentIds.get(sector.id) : alertIds.get(sector.id);
    if (!alertId) continue;
    const info = await tx.query<{ window_key: string }>('SELECT window_key FROM alerts WHERE id = $1', [alertId]);
    const hvacEval = sector.relatedHvacCode ? lastLevel.get(sector.relatedHvacCode) : null;
    items.push({
      sectorCode: sector.code, sectorName: sector.name, kind: sector.kind, reason: c.reason, severity: c.severity,
      openedAt: c.alert.openedAt, evaluatedAt: latestReadingTs,
      pctOver: Number.isFinite(c.alert.peakPctOver) ? c.alert.peakPctOver : null,
      totalExcessKwh: c.alert.totalExcessKwh, totalCostBrl: c.alert.totalExcessKwh * cfg.tariffBrlPerKwh,
      lastExcessKwh: c.excessKwh, windowHours: windowHours(info.rows[0]?.window_key ?? ''),
      occurrences30d: await countRecentOccurrences(tx, sector.id, new Date(now.getTime() - 30 * DAY), alertId),
      hvacElevated: !!hvacEval && LEVEL_RANK[hvacEval.level] >= LEVEL_RANK.alto,
    });
    links.push({ alertId, reason: c.reason, prevAt: c.alert.lastNotifiedAt, prevSev: c.alert.lastNotifiedSeverity, sector: sector.code });
  }
  if (items.length === 0) return;

  const msgCtx = { unitCode: cfg.code, timezone: cfg.timezone, intervalMin: cfg.expectedIntervalMin, tariffBrlPerKwh: cfg.tariffBrlPerKwh };
  const params = buildWhatsAppParams(items, msgCtx);
  const smsText = buildSmsText(items, msgCtx);
  const desc = deps.notifier.describe(cfg.code);
  const suppressReason = deps.shadow ? 'shadow_mode' : desc.problem ? 'not_configured' : null;
  const notificationId = await insertNotification(tx, {
    unitId: cfg.id, channel: 'whatsapp', kind: 'alert_digest',
    status: suppressReason ? 'suppressed' : 'queued', suppressReason,
    recipientMasked: desc.recipientsMasked.join(','), template: desc.template,
    payload: {
      params, smsText, sectorLabel: params[1], valueLabel: params[3],
      items: items.map(i => ({ sector: i.sectorCode, reason: i.reason, severity: i.severity })),
      ...(desc.problem ? { configurationProblem: desc.problem } : {}),
    },
  });
  await linkAlerts(tx, notificationId, links.map(l => ({ alertId: l.alertId, reason: l.reason, prevNotifiedAt: l.prevAt, prevNotifiedSeverity: l.prevSev })));
  for (const l of links) {
    await tx.query(
      'UPDATE alerts SET last_notified_at = $2, last_notified_severity = $3, notification_count = notification_count + 1, updated_at = now() WHERE id = $1',
      [l.alertId, now, items.find(i => i.sectorCode === l.sector)!.severity]
    );
    // mantém o estado em memória coerente para o resto do ciclo
    const o = outcomes.find(x => x.sectorCode === l.sector);
    if (o?.open) { o.open.lastNotifiedAt = now; o.open.lastNotifiedSeverity = items.find(i => i.sectorCode === l.sector)!.severity; }
  }
  result.notifications.deferred = plan.deferred.length;
  if (suppressReason) {
    result.notifications.suppressed++;
    deps.log.warn('alert.suppressed', { unit: cfg.code, reason: suppressReason, problem: desc.problem, sectors: links.map(l => l.sector) });
  } else {
    result.notifications.queued++;
  }
}

async function deliverQueued(deps: CycleDeps, cfg: UnitConfig): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const now = deps.now();

  for (const id of await loadStuckSending(deps.db, cfg.id, new Date(now.getTime() - 10 * 60000))) {
    await markFailed(deps.db, id, 'Resultado do envio desconhecido (processo interrompido durante o envio)');
    failed++;
  }

  for (const q of await loadQueued(deps.db, cfg.id)) {
    // fila velha demais não se envia: o aviso é reproposto pelo motor com dados atuais
    if (now.getTime() - q.createdAt.getTime() > cfg.policy.freshnessMinutes * 60000) {
      await markFailed(deps.db, q.id, 'Expirada na fila antes do envio');
      failed++;
      continue;
    }
    if (!(await markSending(deps.db, q.id))) continue;
    try {
      const outcome = await deps.notifier.sendDigest({
        unitCode: cfg.code, params: q.payload.params, smsText: q.payload.smsText, sectorLabel: q.payload.sectorLabel, valueLabel: q.payload.valueLabel,
      });
      if (outcome.ok) {
        await markSent(deps.db, q.id, { recipients: outcome.results });
        sent++;
        deps.log.info('notification.sent', { unit: cfg.code, notificationId: q.id, recipients: outcome.results.map(r => ({ recipient: r.recipientMasked, status: r.status, channel: r.channel })) });
      } else {
        await markFailed(deps.db, q.id, outcome.error ?? 'Falha no envio', { recipients: outcome.results });
        failed++;
        deps.log.error('notification.failed', { unit: cfg.code, notificationId: q.id, error: outcome.error, recipients: outcome.results });
      }
    } catch (error: any) {
      await markFailed(deps.db, q.id, error?.message ?? String(error));
      failed++;
      deps.log.error('notification.failed', { unit: cfg.code, notificationId: q.id, error: error?.message ?? String(error) });
    }
  }
  return { sent, failed };
}

export type { StoredAlert };
