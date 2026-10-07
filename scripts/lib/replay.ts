// Backtest do motor V2: reproduz, leitura a leitura, o que o sistema decidiria
// com dados históricos reais — incluindo normalização, baseline em cache
// (recalculado de tempos em tempos, como em produção), ciclo de vida e política
// de notificação. Permite calibrar parâmetros com evidência e medir recall com
// anomalias injetadas.
import { isBaselineEligible, isEvaluable, type NormalizedReading } from '../../core/telemetry/normalize.js';
import {
  buildBaselineSet,
  baselineForInstant,
  type BaselineContext,
  type BaselineSample,
  type BaselineSet,
} from '../../core/alerts/baseline.js';
import { evaluateValue } from '../../core/alerts/detector.js';
import { initialSectorState, stepSector, type SectorState } from '../../core/alerts/lifecycle.js';
import {
  collectCandidates,
  planNotifications,
  type CycleSectorOutcome,
  type NotifyCandidate,
} from '../../core/alerts/policy.js';
import { DEFAULT_NOTIFY_POLICY, DEFAULT_RULES, type NotifyPolicy, type RuleSet } from '../../core/alerts/rules.js';
import { DEFAULT_WINDOWS, windowFor, type OperationalWindow } from '../../core/alerts/windows.js';
import type { LifecycleEvent } from '../../core/alerts/lifecycle.js';
import type { Severity } from '../../core/alerts/types.js';
import { localParts } from '../../core/time.js';
import type { LoadedUnit } from './load.js';

export interface Injection {
  sectorCode: string;
  /** primeira leitura afetada */
  startTs: Date;
  /** quantas leituras consecutivas */
  readings: number;
  /** multiplicador sobre o valor real */
  factor: number;
}

export interface ReplayOptions {
  rules?: RuleSet;
  policy?: NotifyPolicy;
  windows?: readonly OperationalWindow[];
  /** avalia os últimos N dias do histórico */
  days?: number;
  baselineRefreshHours?: number;
  injections?: Injection[];
}

export interface IncidentRecord {
  sectorCode: string;
  openedAt: Date;
  openedSeverity: Severity;
  peakSeverity: Severity;
  recoveredAt: Date | null;
  excessKwh: number;
  notifiedAt: Date | null;
}

export interface MessageRecord {
  ts: Date;
  reasons: string[];
  sectors: string[];
  topSeverity: Severity;
}

export interface ReplayResult {
  cycles: number;
  from: Date;
  to: Date;
  incidents: IncidentRecord[];
  messages: MessageRecord[];
  /** quantas leituras avaliáveis cruzaram cada nível (sem persistência) — dá a taxa "crua" do detector */
  rawBreaches: Record<string, number>;
  perDay: Record<string, { messages: number; incidents: number }>;
}

interface Prepared {
  reading: NormalizedReading;
  value: number | null;
  evaluable: boolean;
  eligible: boolean;
  windowKey?: string;
  dayType?: 'weekday' | 'weekend';
}

/** Permite experimentar parâmetros sem editar código: RULES_JSON='{"levels":{...}}' (mescla sobre o padrão). */
function envOverride<T extends object>(base: T, name: string): T {
  const raw = process.env[name];
  if (!raw) return base;
  const patch = JSON.parse(raw) as Record<string, unknown>;
  const merge = (a: any, b: any): any =>
    Object.fromEntries(Object.keys({ ...a, ...b }).map(k => [k, b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] ?? {}, b[k]) : (k in b ? b[k] : a[k])]));
  return merge(base, patch) as T;
}

export function replayUnit(loaded: LoadedUnit, options: ReplayOptions = {}): ReplayResult {
  const rules = options.rules ?? envOverride(DEFAULT_RULES, 'RULES_JSON');
  const policy = options.policy ?? envOverride(DEFAULT_NOTIFY_POLICY, 'POLICY_JSON');
  const windows = options.windows ?? DEFAULT_WINDOWS;
  const { unit } = loaded;
  const refreshMs = (options.baselineRefreshHours ?? 6) * 3600000;
  const ctx: BaselineContext = { windows, intervalMin: unit.expectedIntervalMin, timeZone: unit.timezone, rules };

  const monitored = unit.sectors.filter(s => s.monitored);
  const injections = options.injections ?? [];

  // --- prepara leituras por setor (com injeções e faixa pré-calculada) -----
  const perSector = new Map<string, Prepared[]>();
  for (const s of monitored) perSector.set(s.code, []);
  for (const r of loaded.readings) {
    const list = perSector.get(r.sectorCode);
    if (!list) continue;
    let value = r.intervalKwh;
    if (value !== null) {
      for (const inj of injections) {
        if (inj.sectorCode !== r.sectorCode) continue;
        const offset = (r.ts.getTime() - inj.startTs.getTime()) / (unit.expectedIntervalMin * 60000);
        if (offset > -0.5 && offset < inj.readings - 0.5) value = value * inj.factor;
      }
    }
    const hit = windowFor(windows, r.ts, unit.expectedIntervalMin, unit.timezone);
    list.push({
      reading: r,
      value,
      evaluable: isEvaluable(r),
      eligible: isBaselineEligible(r),
      windowKey: hit?.window.key,
      dayType: hit?.dayType,
    });
  }

  const timestamps = [...new Set(loaded.readings.map(r => r.ts.getTime()))].sort((a, b) => a - b);
  const lastTs = timestamps[timestamps.length - 1];
  const startTs = options.days ? lastTs - options.days * 86400000 : timestamps[0] + rules.lookbackDays * 86400000 * 0.5;
  const startIdx = Math.max(1, timestamps.findIndex(t => t >= startTs));

  const states = new Map<string, SectorState>(monitored.map(s => [s.code, initialSectorState()]));
  const baselines = new Map<string, { set: BaselineSet; builtAt: number }>();
  const cursors = new Map<string, number>(monitored.map(s => [s.code, 0]));

  const incidents: IncidentRecord[] = [];
  const openIncident = new Map<string, IncidentRecord>();
  const messages: MessageRecord[] = [];
  const perDay: ReplayResult['perDay'] = {};
  const rawBreaches: Record<string, number> = { atencao: 0, alto: 0, critico: 0 };
  const bump = (ts: Date, key: 'messages' | 'incidents') => {
    const d = localParts(ts, unit.timezone).dateKey;
    perDay[d] ??= { messages: 0, incidents: 0 };
    perDay[d][key]++;
  };

  for (let i = startIdx; i < timestamps.length; i++) {
    const tNow = timestamps[i];
    const ts = new Date(tNow);
    const outcomes: CycleSectorOutcome[] = [];

    for (const sector of monitored) {
      const list = perSector.get(sector.code)!;
      // avança o cursor até a leitura deste instante
      let c = cursors.get(sector.code)!;
      while (c < list.length && list[c].reading.ts.getTime() < tNow) c++;
      cursors.set(sector.code, c);
      const current = list[c]?.reading.ts.getTime() === tNow ? list[c] : null;
      if (!current) continue;

      // baseline em cache, reconstruído a cada `refreshMs`
      let cache = baselines.get(sector.code);
      if (!cache || tNow - cache.builtAt >= refreshMs) {
        const samples: BaselineSample[] = [];
        const sinceMs = tNow - rules.lookbackDays * 86400000;
        for (let k = c - 1; k >= 0 && list[k].reading.ts.getTime() >= sinceMs; k--) {
          const p = list[k];
          if (p.eligible && p.value !== null) {
            samples.push({ ts: p.reading.ts, kwh: p.value, windowKey: p.windowKey, dayType: p.dayType });
          }
        }
        cache = { set: buildBaselineSet(samples, ts, ctx), builtAt: tNow };
        baselines.set(sector.code, cache);
      }

      let evaluation = null;
      if (current.evaluable && current.value !== null) {
        const bi = baselineForInstant(cache.set, ts, ctx);
        if (bi?.baseline) {
          evaluation = evaluateValue(current.value, bi.baseline, bi.window, bi.dayType, rules, unit.expectedIntervalMin);
          if (evaluation.level !== 'normal') rawBreaches[evaluation.level]++;
        }
      }

      const { state, events } = stepSector(states.get(sector.code)!, ts, evaluation, rules);
      states.set(sector.code, state);
      trackIncidents(sector.code, ts, events, state, incidents, openIncident, bump);
      outcomes.push({
        sectorCode: sector.code,
        events,
        open: state.open,
        closedAlert: events.find(e => e.type === 'recovered')?.alert ?? null,
        lastExcessKwh: evaluation?.excessKwh ?? 0,
      });
    }

    // política de notificação (uma "cron" por leitura, com 1 min de atraso)
    const now = new Date(tNow + 60000);
    const sentLastHour = messages.filter(m => now.getTime() - m.ts.getTime() <= 3600000).length;
    const candidates = collectCandidates(outcomes, policy, now, ts);
    const plan = planNotifications(candidates, policy, sentLastHour);
    if (plan.send.length > 0) {
      markNotified(plan.send, states, now);
      for (const cand of plan.send) {
        const inc = openIncident.get(cand.sectorCode);
        if (inc && !inc.notifiedAt) inc.notifiedAt = now;
      }
      messages.push({
        ts: now,
        reasons: plan.send.map(c => c.reason),
        sectors: plan.send.map(c => c.sectorCode),
        topSeverity: plan.send[0].severity,
      });
      bump(now, 'messages');
    }
  }

  return {
    cycles: timestamps.length - startIdx,
    from: new Date(timestamps[startIdx]),
    to: new Date(lastTs),
    incidents,
    messages,
    rawBreaches,
    perDay,
  };
}

function markNotified(sent: readonly NotifyCandidate[], states: Map<string, SectorState>, now: Date) {
  for (const c of sent) {
    const st = states.get(c.sectorCode);
    if (st?.open && c.reason !== 'recovered') {
      st.open.lastNotifiedAt = now;
      st.open.lastNotifiedSeverity = st.open.severity;
    }
  }
}

function trackIncidents(
  sectorCode: string,
  ts: Date,
  events: readonly LifecycleEvent[],
  state: SectorState,
  incidents: IncidentRecord[],
  open: Map<string, IncidentRecord>,
  bump: (ts: Date, key: 'messages' | 'incidents') => void
) {
  for (const ev of events) {
    if (ev.type === 'opened') {
      const rec: IncidentRecord = {
        sectorCode,
        openedAt: ev.runStartedAt,
        openedSeverity: ev.severity,
        peakSeverity: ev.severity,
        recoveredAt: null,
        excessKwh: 0,
        notifiedAt: null,
      };
      incidents.push(rec);
      open.set(sectorCode, rec);
      bump(ts, 'incidents');
    } else if (ev.type === 'reopened') {
      // o mesmo incidente volta (pisca-pisca): reaproveita o último registro do setor
      const last = [...incidents].reverse().find(r => r.sectorCode === sectorCode);
      if (last) {
        last.recoveredAt = null;
        open.set(sectorCode, last);
      }
    } else if (ev.type === 'escalated') {
      const rec = open.get(sectorCode);
      if (rec) rec.peakSeverity = ev.to;
    } else if (ev.type === 'recovered') {
      const rec = open.get(sectorCode);
      if (rec) {
        rec.recoveredAt = ts;
        open.delete(sectorCode);
      }
    }
  }
  const rec = open.get(sectorCode);
  if (rec && state.open) rec.excessKwh = state.open.totalExcessKwh;
}

export function summarizeReplay(result: ReplayResult, unitName: string): string {
  const days = Math.max(1, (result.to.getTime() - result.from.getTime()) / 86400000);
  const lines: string[] = [];
  lines.push(`${unitName}: ${result.cycles} ciclos (${days.toFixed(1)} dias)  ${result.from.toISOString().slice(0, 16)} → ${result.to.toISOString().slice(0, 16)}`);
  lines.push(
    `  cruzamentos brutos (leituras acima do limite, sem persistência): atenção=${result.rawBreaches.atencao} alto=${result.rawBreaches.alto} crítico=${result.rawBreaches.critico}`
  );
  const bySev: Record<string, number> = {};
  for (const i of result.incidents) bySev[i.peakSeverity] = (bySev[i.peakSeverity] ?? 0) + 1;
  lines.push(`  incidentes: ${result.incidents.length} (${(result.incidents.length / days).toFixed(1)}/dia)  por pico:`, `    ${JSON.stringify(bySev)}`);
  const msgDays = Object.values(result.perDay).map(d => d.messages);
  const max = msgDays.length ? Math.max(...msgDays) : 0;
  lines.push(`  mensagens WhatsApp: ${result.messages.length} (${(result.messages.length / days).toFixed(1)}/dia, máx ${max} em um dia)`);
  const durations = result.incidents.filter(i => i.recoveredAt).map(i => (i.recoveredAt!.getTime() - i.openedAt.getTime()) / 3600000);
  if (durations.length) {
    durations.sort((a, b) => a - b);
    lines.push(`  duração dos incidentes recuperados: mediana ${durations[Math.floor(durations.length / 2)].toFixed(1)} h, máx ${durations[durations.length - 1].toFixed(1)} h`);
  }
  const perSector: Record<string, number> = {};
  for (const i of result.incidents) perSector[i.sectorCode] = (perSector[i.sectorCode] ?? 0) + 1;
  const top = Object.entries(perSector).sort((a, b) => b[1] - a[1]).slice(0, 8);
  lines.push(`  top setores por incidentes: ${top.map(([k, n]) => `${k}:${n}`).join(' | ')}`);
  return lines.join('\n');
}
