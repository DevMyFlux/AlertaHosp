// Ciclo de vida de um alerta por setor: persistência → abre → escala → recupera.
//
// Função pura: recebe o estado anterior + a avaliação de UMA leitura e devolve
// o novo estado e os eventos ocorridos. Determinística — mesmo input, mesmo
// output — então é testável sem banco e reproduzível em backtest.
//
// Regras:
//  • PERSISTÊNCIA: um nível só conta depois de `persistence` leituras
//    consecutivas naquele nível (ou acima). Pico isolado não abre alerta.
//  • ABRE: no maior nível cuja persistência foi atingida.
//  • ESCALA por nível (um nível maior atinge a persistência dele) e por
//    DURAÇÃO (alerta que não se resolve sobe de severidade em vez de repetir
//    a mesma mensagem). Nunca desce — a descida só ocorre pela recuperação.
//  • RECUPERA: `recoveryReadings` leituras normais consecutivas fecham o alerta.
//  • REABRE: voltar a violar dentro de `reopenGraceMinutes` após recuperar é o
//    MESMO alerta (sem nova abertura nem nova mensagem) — evita pisca-pisca.
//  • Leituras não avaliáveis (inválidas, em quarentena, sem baseline) não
//    alteram o estado: dado ruim não abre nem fecha alerta.

import type { Evaluation } from './detector.js';
import type { RuleSet } from './rules.js';
import { LEVEL_RANK, SEVERITIES, type Severity } from './types.js';

export interface OpenAlertState {
  severity: Severity;
  peakSeverity: Severity;
  openedAt: Date;
  /** quando a severidade atual começou (base do escalonamento por duração) */
  severityChangedAt: Date;
  lastBreachAt: Date;
  breachCount: number;
  peakValueKwh: number;
  peakPctOver: number;
  baselineKwh: number;
  totalExcessKwh: number;
  lastNotifiedAt: Date | null;
  lastNotifiedSeverity: Severity | null;
}

export interface SectorState {
  /** leituras consecutivas em cada nível ou acima */
  run: Record<Severity, number>;
  runStartedAt: Date | null;
  runExcessKwh: number;
  normalStreak: number;
  open: OpenAlertState | null;
  /** último alerta recuperado — candidato a reabrir dentro da tolerância */
  recentlyClosed: { alert: OpenAlertState; closedAt: Date } | null;
}

export function initialSectorState(): SectorState {
  return {
    run: { atencao: 0, alto: 0, critico: 0 },
    runStartedAt: null,
    runExcessKwh: 0,
    normalStreak: 0,
    open: null,
    recentlyClosed: null,
  };
}

export type LifecycleEvent =
  | { type: 'opened'; ts: Date; severity: Severity; evaluation: Evaluation; runStartedAt: Date }
  | { type: 'reopened'; ts: Date; severity: Severity; evaluation: Evaluation }
  | { type: 'escalated'; ts: Date; from: Severity; to: Severity; reason: 'level' | 'duration'; evaluation: Evaluation }
  | { type: 'breach'; ts: Date; severity: Severity; evaluation: Evaluation }
  | { type: 'recovered'; ts: Date; evaluation: Evaluation; durationMinutes: number; alert: OpenAlertState };

function cloneState(s: SectorState): SectorState {
  return {
    ...s,
    run: { ...s.run },
    open: s.open ? { ...s.open } : null,
    recentlyClosed: s.recentlyClosed ? { ...s.recentlyClosed, alert: { ...s.recentlyClosed.alert } } : null,
  };
}

function highestSustained(run: Record<Severity, number>, rules: RuleSet, above: number): Severity | null {
  for (const sev of [...SEVERITIES].reverse()) {
    if (LEVEL_RANK[sev] > above && run[sev] >= rules.levels[sev].persistence) return sev;
  }
  return null;
}

const minutes = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60000;

/**
 * Avança o estado do setor com a avaliação de uma leitura. `evaluation = null`
 * significa "leitura não avaliável": estado inalterado.
 */
export function stepSector(
  prev: SectorState,
  ts: Date,
  evaluation: Evaluation | null,
  rules: RuleSet
): { state: SectorState; events: LifecycleEvent[] } {
  if (!evaluation) return { state: prev, events: [] };

  const state = cloneState(prev);
  const events: LifecycleEvent[] = [];
  const rank = LEVEL_RANK[evaluation.level];
  const breaching = rank >= LEVEL_RANK.atencao;

  if (state.recentlyClosed && minutes(state.recentlyClosed.closedAt, ts) > rules.reopenGraceMinutes) {
    state.recentlyClosed = null;
  }

  for (const sev of SEVERITIES) state.run[sev] = rank >= LEVEL_RANK[sev] ? state.run[sev] + 1 : 0;
  if (breaching) {
    state.runStartedAt ??= ts;
    state.runExcessKwh += evaluation.excessKwh;
  } else {
    state.runStartedAt = null;
    state.runExcessKwh = 0;
  }

  const open = state.open;
  if (open) {
    if (breaching) {
      state.normalStreak = 0;
      open.lastBreachAt = ts;
      open.breachCount += 1;
      open.totalExcessKwh += evaluation.excessKwh;
      if (evaluation.value > open.peakValueKwh) {
        open.peakValueKwh = evaluation.value;
        open.peakPctOver = evaluation.pctOver;
        open.baselineKwh = evaluation.expected;
      }
      events.push({ type: 'breach', ts, severity: evaluation.level as Severity, evaluation });

      const byLevel = highestSustained(state.run, rules, LEVEL_RANK[open.severity]);
      let target: Severity | null = byLevel;
      let reason: 'level' | 'duration' = 'level';
      if (!target && open.severity !== 'critico') {
        const limit = open.severity === 'atencao' ? rules.escalateAfterMinutes.atencao : rules.escalateAfterMinutes.alto;
        if (minutes(open.severityChangedAt, ts) >= limit) {
          target = open.severity === 'atencao' ? 'alto' : 'critico';
          reason = 'duration';
        }
      }
      if (target) {
        events.push({ type: 'escalated', ts, from: open.severity, to: target, reason, evaluation });
        open.severity = target;
        open.severityChangedAt = ts;
        if (LEVEL_RANK[target] > LEVEL_RANK[open.peakSeverity]) open.peakSeverity = target;
      }
    } else {
      state.normalStreak += 1;
      if (state.normalStreak >= rules.recoveryReadings) {
        events.push({
          type: 'recovered',
          ts,
          evaluation,
          durationMinutes: minutes(open.openedAt, ts),
          alert: { ...open },
        });
        state.recentlyClosed = { alert: { ...open }, closedAt: ts };
        state.open = null;
        state.normalStreak = 0;
        state.run = { atencao: 0, alto: 0, critico: 0 };
      }
    }
    return { state, events };
  }

  // sem alerta aberto: persistência atingida?
  const candidate = highestSustained(state.run, rules, 0);
  if (!candidate) return { state, events };

  const startedAt = state.runStartedAt ?? ts;
  state.normalStreak = 0;

  if (state.recentlyClosed) {
    // mesmo alerta: continua de onde parou, mantendo o que já foi notificado
    const prevAlert = state.recentlyClosed.alert;
    state.open = {
      ...prevAlert,
      severity: candidate,
      peakSeverity: LEVEL_RANK[candidate] > LEVEL_RANK[prevAlert.peakSeverity] ? candidate : prevAlert.peakSeverity,
      severityChangedAt: ts,
      lastBreachAt: ts,
      breachCount: prevAlert.breachCount + state.run.atencao,
      totalExcessKwh: prevAlert.totalExcessKwh + state.runExcessKwh,
    };
    if (evaluation.value > state.open.peakValueKwh) {
      state.open.peakValueKwh = evaluation.value;
      state.open.peakPctOver = evaluation.pctOver;
      state.open.baselineKwh = evaluation.expected;
    }
    state.recentlyClosed = null;
    events.push({ type: 'reopened', ts, severity: candidate, evaluation });
    return { state, events };
  }

  state.open = {
    severity: candidate,
    peakSeverity: candidate,
    openedAt: startedAt,
    severityChangedAt: ts,
    lastBreachAt: ts,
    breachCount: state.run.atencao,
    peakValueKwh: evaluation.value,
    peakPctOver: evaluation.pctOver,
    baselineKwh: evaluation.expected,
    totalExcessKwh: state.runExcessKwh,
    lastNotifiedAt: null,
    lastNotifiedSeverity: null,
  };
  events.push({ type: 'opened', ts, severity: candidate, evaluation, runStartedAt: startedAt });
  return { state, events };
}
