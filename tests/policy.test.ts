import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectCandidates, planNotifications, type CycleSectorOutcome } from '../core/alerts/policy.js';
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '../core/alerts/rules.js';
import type { OpenAlertState, LifecycleEvent } from '../core/alerts/lifecycle.js';
import type { Severity } from '../core/alerts/types.js';
import { at, evaluation } from './helpers.js';

const policy: NotifyPolicy = { ...DEFAULT_NOTIFY_POLICY };

function alert(over: Partial<OpenAlertState> = {}): OpenAlertState {
  return {
    severity: 'alto',
    peakSeverity: 'alto',
    openedAt: at(0),
    severityChangedAt: at(0),
    lastBreachAt: at(15),
    breachCount: 2,
    peakValueKwh: 20,
    peakPctOver: 1,
    baselineKwh: 10,
    totalExcessKwh: 40,
    lastNotifiedAt: null,
    lastNotifiedSeverity: null,
    ...over,
  };
}

function outcome(code: string, open: OpenAlertState | null, events: LifecycleEvent['type'][] = [], over: Partial<CycleSectorOutcome> = {}): CycleSectorOutcome {
  const ev = evaluation('alto');
  return {
    sectorCode: code,
    open,
    closedAlert: null,
    lastExcessKwh: 10,
    events: events.map(type => ({ type, ts: at(15), severity: 'alto' as Severity, evaluation: ev, runStartedAt: at(0), from: 'atencao' as Severity, to: 'alto' as Severity, reason: 'level' as const }) as unknown as LifecycleEvent),
    ...over,
  };
}

const NOW = at(16);
const FRESH = at(15);

describe('política de notificação', () => {
  test('severidade abaixo do mínimo fica só no painel', () => {
    const c = collectCandidates([outcome('A', alert({ severity: 'atencao', peakSeverity: 'atencao' }), ['opened'])], policy, NOW, FRESH);
    assert.equal(c.length, 0);
  });

  test('alerta aberto em ALTO notifica uma única vez (cooldown)', () => {
    const open = alert();
    const first = collectCandidates([outcome('A', open, ['opened'])], policy, NOW, FRESH);
    assert.deepEqual(first.map(x => x.reason), ['opened']);

    open.lastNotifiedAt = NOW;
    open.lastNotifiedSeverity = 'alto';
    const next = collectCandidates([outcome('A', open, ['breach'])], policy, at(31), at(30));
    assert.equal(next.length, 0, 'sem repetir a mesma mensagem a cada ciclo');
  });

  test('lembra depois do intervalo configurado, não antes', () => {
    const open = alert({ lastNotifiedAt: at(0), lastNotifiedSeverity: 'alto' });
    const early = collectCandidates([outcome('A', open)], policy, at(policy.reminderMinutes.alto! - 5), at(policy.reminderMinutes.alto! - 5));
    assert.equal(early.length, 0);
    const t = at(policy.reminderMinutes.alto! + 1);
    const late = collectCandidates([outcome('A', open)], policy, t, t);
    assert.deepEqual(late.map(x => x.reason), ['reminder']);
  });

  test('escalada para severidade maior notifica na hora, mesmo dentro do cooldown', () => {
    const open = alert({ severity: 'critico', peakSeverity: 'critico', lastNotifiedAt: at(10), lastNotifiedSeverity: 'alto' });
    const c = collectCandidates([outcome('A', open, ['escalated'])], policy, NOW, FRESH);
    assert.deepEqual(c.map(x => x.reason), ['escalated']);
    assert.equal(c[0].severity, 'critico');
  });

  test('só notifica quando o excesso acumulado compensa o custo da mensagem', () => {
    const small = alert({ totalExcessKwh: policy.minExcessKwhToNotify - 1 });
    assert.equal(collectCandidates([outcome('A', small, ['opened'])], policy, NOW, FRESH).length, 0);
    const grown = alert({ totalExcessKwh: policy.minExcessKwhToNotify + 1 });
    // ciclo seguinte, sem evento novo: ainda nunca notificado ⇒ notifica agora que compensa
    assert.equal(collectCandidates([outcome('A', grown, ['breach'])], policy, NOW, FRESH).length, 1);
  });

  test('dado velho (fonte parada) não gera aviso', () => {
    const c = collectCandidates([outcome('A', alert(), ['opened'])], policy, at(200), at(15));
    assert.equal(c.length, 0);
  });

  test('aviso de recuperação só se habilitado e só se o alerta chegou a ser notificado', () => {
    const closed = alert({ lastNotifiedAt: at(5), lastNotifiedSeverity: 'alto' });
    const o = outcome('A', null, ['recovered'], { closedAlert: closed });
    assert.equal(collectCandidates([o], policy, NOW, FRESH).length, 0);
    const on = collectCandidates([o], { ...policy, notifyOnRecovery: true }, NOW, FRESH);
    assert.deepEqual(on.map(x => x.reason), ['recovered']);
    const never = outcome('A', null, ['recovered'], { closedAlert: alert() });
    assert.equal(collectCandidates([never], { ...policy, notifyOnRecovery: true }, NOW, FRESH).length, 0);
  });
});

describe('planejamento: agrupamento e limite de taxa', () => {
  const cands = (sevs: [string, Severity, number][]) =>
    collectCandidates(
      sevs.map(([code, sev, exc]) => outcome(code, alert({ severity: sev, peakSeverity: sev }), ['opened'], { lastExcessKwh: exc })),
      policy,
      NOW,
      FRESH
    );

  test('vários setores no mesmo ciclo saem em UMA mensagem, do mais grave ao menos grave', () => {
    const plan = planNotifications(cands([['A', 'alto', 5], ['B', 'critico', 1], ['C', 'alto', 30]]), policy, 0);
    assert.equal(plan.reason, null);
    assert.deepEqual(plan.send.map(c => c.sectorCode), ['B', 'C', 'A']);
  });

  test('teto por hora adia avisos comuns, mas nunca retém CRÍTICO', () => {
    const cap = policy.maxPerUnitPerHour;
    const alto = planNotifications(cands([['A', 'alto', 5]]), policy, cap);
    assert.equal(alto.reason, 'rate_limited');
    assert.equal(alto.send.length, 0);
    assert.equal(alto.deferred.length, 1);
    const crit = planNotifications(cands([['A', 'alto', 5], ['B', 'critico', 5]]), policy, cap);
    assert.equal(crit.send.length, 2);
  });

  test('sem candidatos não há mensagem', () => {
    assert.equal(planNotifications([], policy, 0).reason, 'nothing_to_send');
  });
});
