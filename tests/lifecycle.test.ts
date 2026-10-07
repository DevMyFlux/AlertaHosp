import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initialSectorState, stepSector, type SectorState, type LifecycleEvent } from '../core/alerts/lifecycle.js';
import { DEFAULT_RULES, type RuleSet } from '../core/alerts/rules.js';
import type { Level } from '../core/alerts/types.js';
import { at, evaluation } from './helpers.js';

const STEP = 15;
const rules: RuleSet = DEFAULT_RULES;

/** executa uma sequência de níveis (uma leitura a cada 15 min) e devolve estado + eventos por passo */
function run(levels: (Level | null)[], start: SectorState = initialSectorState(), r: RuleSet = rules, t0 = 0) {
  let state = start;
  const all: LifecycleEvent[][] = [];
  levels.forEach((lv, i) => {
    const out = stepSector(state, at(t0 + i * STEP), lv === null ? null : evaluation(lv), r);
    state = out.state;
    all.push(out.events);
  });
  return { state, all, types: all.map(es => es.map(e => e.type)) };
}

describe('ciclo de vida do alerta', () => {
  test('pico isolado não abre alerta (persistência)', () => {
    const { state, types } = run(['normal', 'alto', 'normal', 'normal']);
    assert.equal(state.open, null);
    assert.ok(types.every(t => !t.includes('opened')));
  });

  test('duas leituras consecutivas acima do limite abrem o alerta no nível sustentado', () => {
    const { state, types } = run(['normal', 'alto', 'alto']);
    assert.deepEqual(types[2], ['opened']);
    assert.equal(state.open?.severity, 'alto');
    assert.equal(state.open?.breachCount, 2);
    // openedAt = primeira leitura da sequência, não a da confirmação
    assert.equal(state.open?.openedAt.getTime(), at(STEP).getTime());
  });

  test('o excesso da leitura que antecedeu a abertura entra no total', () => {
    const { state } = run(['alto', 'alto']);
    assert.equal(state.open?.totalExcessKwh, 20); // 10 + 10 (valor 20 vs esperado 10)
  });

  test('nível misto: atenção, alto → abre como atenção e escala quando alto se sustenta', () => {
    const { state, types } = run(['atencao', 'atencao', 'alto', 'alto']);
    assert.deepEqual(types[1], ['opened']);
    assert.equal(types[3].includes('escalated'), true);
    assert.equal(state.open?.severity, 'alto');
    assert.equal(state.open?.peakSeverity, 'alto');
  });

  test('crítico exige persistência própria', () => {
    const { state } = run(['critico', 'alto', 'critico', 'critico']);
    assert.equal(state.open?.severity, 'critico');
  });

  test('recupera após N leituras normais consecutivas; uma só leitura normal não fecha', () => {
    const open = run(['alto', 'alto']);
    const flap = run(['normal', 'alto', 'normal', 'normal'], open.state);
    assert.ok(flap.state.open, 'ainda aberto: sequência normal interrompida por violação');
    const rec = run(['normal', 'normal', 'normal'], open.state);
    assert.equal(rec.state.open, null);
    assert.deepEqual(rec.types[2], ['recovered']);
    const ev = rec.all[2][0];
    assert.equal(ev.type, 'recovered');
    if (ev.type === 'recovered') assert.ok(ev.durationMinutes >= 0);
  });

  test('reabre o MESMO alerta se voltar a violar dentro da tolerância (anti pisca-pisca)', () => {
    const open = run(['alto', 'alto']);
    open.state.open!.lastNotifiedAt = at(40);
    open.state.open!.lastNotifiedSeverity = 'alto';
    const closed = run(['normal', 'normal', 'normal'], open.state, rules, 2 * STEP);
    const again = run(['alto', 'alto'], closed.state, rules, 5 * STEP);
    assert.deepEqual(again.types[1], ['reopened']);
    assert.equal(again.state.open?.lastNotifiedAt?.getTime(), at(40).getTime()); // não perde o histórico de notificação
    assert.ok((again.state.open?.breachCount ?? 0) > 2);
  });

  test('depois da tolerância é um alerta novo', () => {
    const open = run(['alto', 'alto']);
    const closed = run(['normal', 'normal', 'normal'], open.state, rules, 2 * STEP);
    const t = 5 * STEP + rules.reopenGraceMinutes + 30;
    const again = run(['alto', 'alto'], closed.state, rules, t);
    assert.deepEqual(again.types[1], ['opened']);
  });

  test('leitura não avaliável (inválida/quarentena) não abre, não fecha e não zera a contagem', () => {
    const a = run(['alto', null, null, null, 'alto']);
    assert.ok(a.state.open, 'dado ruim no meio não impede a persistência');
    const open = run(['alto', 'alto']);
    const gap = run([null, null, null, null, null], open.state, rules, 2 * STEP);
    assert.ok(gap.state.open, 'dado ausente não recupera alerta');
  });

  test('escalonamento por duração: atenção que não se resolve sobe para alto', () => {
    const n = rules.escalateAfterMinutes.atencao / STEP + 3;
    const { state, all } = run(Array<Level>(n).fill('atencao'));
    assert.equal(state.open?.severity, 'alto');
    const esc = all.flat().find(e => e.type === 'escalated');
    assert.ok(esc && esc.type === 'escalated' && esc.reason === 'duration');
  });

  test('severidade nunca desce enquanto aberto, mesmo com leituras mais brandas', () => {
    const { state } = run(['alto', 'alto', 'atencao', 'atencao', 'atencao']);
    assert.equal(state.open?.severity, 'alto');
  });

  test('é determinístico e não muta o estado anterior', () => {
    const s0 = initialSectorState();
    const snapshot = JSON.stringify(s0);
    stepSector(s0, at(0), evaluation('alto'), rules);
    assert.equal(JSON.stringify(s0), snapshot);
  });
});
