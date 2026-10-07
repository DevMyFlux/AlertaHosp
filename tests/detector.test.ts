import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaselineSet, pickBaseline, type BaselineContext, type BaselineSample } from '../core/alerts/baseline.js';
import { evaluateValue } from '../core/alerts/detector.js';
import { DEFAULT_RULES, type RuleSet } from '../core/alerts/rules.js';
import { DEFAULT_WINDOWS, validateWindows, windowFor, type OperationalWindow } from '../core/alerts/windows.js';
import { median } from '../core/stats.js';

const TZ = 'America/Sao_Paulo';
const ctx = (rules: RuleSet = DEFAULT_RULES, intervalMin = 15): BaselineContext => ({ windows: DEFAULT_WINDOWS, intervalMin, timeZone: TZ, rules });
const tarde = DEFAULT_WINDOWS.find(w => w.key === 'tarde')!;

/** dias úteis consecutivos, uma amostra por intervalo entre 14:00 e 18:00 locais (UTC−3) */
function afternoonSamples(days: number, valueAt: (i: number) => number, startDay = 1, intervalMin = 15): BaselineSample[] {
  const out: BaselineSample[] = [];
  let i = 0;
  for (let d = 0; d < days; d++) {
    const day = startDay + d; // 2026-09-01 é terça
    for (let m = 14 * 60 + intervalMin; m <= 18 * 60; m += intervalMin) {
      out.push({ ts: new Date(Date.UTC(2026, 8, day, 3 + Math.floor(m / 60), m % 60)), kwh: valueAt(i++) });
    }
  }
  return out;
}

describe('faixas operacionais', () => {
  test('o conjunto padrão cobre as 24 h sem lacuna nem sobreposição', () => {
    assert.deepEqual(validateWindows(DEFAULT_WINDOWS), []);
  });

  test('detecta lacuna e sobreposição', () => {
    const bad: OperationalWindow[] = [
      { key: 'a', name: 'A', startMin: 0, endMin: 600, dayType: 'all', thresholdMultiplier: 1 },
      { key: 'b', name: 'B', startMin: 500, endMin: 1000, dayType: 'all', thresholdMultiplier: 1 },
    ];
    const problems = validateWindows(bad).join(' | ');
    assert.match(problems, /sobrepõe/);
    assert.match(problems, /nenhuma faixa cobre/);
  });

  test('leitura de 14:00 pertence à faixa que contém 13:45–14:00 (intervalo anterior)', () => {
    const ts = new Date(Date.UTC(2026, 8, 1, 17, 0)); // 14:00 BRT
    assert.equal(windowFor(DEFAULT_WINDOWS, ts, 15, TZ)?.window.key, 'almoco');
    const ts2 = new Date(Date.UTC(2026, 8, 1, 17, 15)); // 14:15 BRT
    assert.equal(windowFor(DEFAULT_WINDOWS, ts2, 15, TZ)?.window.key, 'tarde');
  });

  test('tipo de dia vem do calendário local', () => {
    const sat = new Date(Date.UTC(2026, 8, 5, 17, 30)); // sábado 14:30 BRT
    assert.equal(windowFor(DEFAULT_WINDOWS, sat, 15, TZ)?.dayType, 'weekend');
  });
});

describe('baseline robusto', () => {
  const asOf = new Date(Date.UTC(2026, 8, 25, 12, 0));

  test('mediana/σ robustos ignoram outliers; média seria arruinada', () => {
    const vals = afternoonSamples(10, i => (i % 7 === 0 ? 5000 : 10 + (i % 3) * 0.1));
    const set = buildBaselineSet(vals, asOf, ctx());
    const b = pickBaseline(set, 'tarde', 'weekday', 24)!;
    assert.ok(Math.abs(b.median - 10.1) < 0.2, `mediana ${b.median}`);
    assert.ok(b.sigma < 1, `sigma ${b.sigma}`);
    assert.ok(b.mean > 500, 'a média clássica seria destruída pelos outliers');
  });

  test('só usa amostras anteriores a asOf e dentro do lookback', () => {
    const old = afternoonSamples(3, () => 100, -10); // ~35 dias antes: fora do lookback de 28
    const recent = afternoonSamples(3, () => 10, 22);
    const future = afternoonSamples(2, () => 999, 26);
    const set = buildBaselineSet([...old, ...recent, ...future], asOf, ctx());
    const b = pickBaseline(set, 'tarde', 'weekday', 1)!;
    assert.equal(b.median, 10);
    assert.equal(b.n, recent.length);
  });

  test('sem amostras suficientes devolve null (setor "aprendendo") em vez de chutar', () => {
    const set = buildBaselineSet(afternoonSamples(1, () => 10), asOf, ctx());
    assert.equal(pickBaseline(set, 'tarde', 'weekday', 24), null);
  });

  test('cai para o agregado da faixa quando o tipo de dia específico não tem amostra', () => {
    const set = buildBaselineSet(afternoonSamples(3, () => 10), asOf, ctx()); // ter–qui: sem amostra de fim de semana
    const wk = pickBaseline(set, 'tarde', 'weekend', 10);
    assert.equal(wk?.dayType, 'all');
  });

  test('detecta contador inteiro (degrau de 1 kWh)', () => {
    const set = buildBaselineSet(afternoonSamples(10, i => 3 + (i % 3)), asOf, ctx());
    assert.equal(pickBaseline(set, 'tarde', 'weekday', 24)!.quantum, 1);
  });
});

describe('detector', () => {
  const asOf = new Date(Date.UTC(2026, 8, 25, 12, 0));
  const stable = pickBaseline(buildBaselineSet(afternoonSamples(15, i => 20 + ((i * 7) % 5) * 0.2), asOf, ctx()), 'tarde', 'weekday', 24)!;
  const evalAt = (v: number, b = stable, rules = DEFAULT_RULES, win = tarde) => evaluateValue(v, b, win, 'weekday', rules, 15);

  test('valor normal e variação pequena não geram nível', () => {
    assert.equal(evalAt(20).level, 'normal');
    assert.equal(evalAt(22).level, 'normal'); // +10%: abaixo de qualquer limite
  });

  test('níveis crescem com o desvio e respeitam a ordem dos limites', () => {
    const e = evalAt(20);
    assert.ok(e.limits.atencao < e.limits.alto && e.limits.alto < e.limits.critico);
    assert.equal(evalAt(e.limits.atencao + 0.01).level, 'atencao');
    assert.equal(evalAt(e.limits.alto + 0.01).level, 'alto');
    assert.equal(evalAt(e.limits.critico + 0.01).level, 'critico');
    assert.equal(evalAt(e.limits.atencao).level, 'normal', 'no limite exato ainda é normal');
  });

  test('a explicação carrega todos os números da decisão', () => {
    const e = evalAt(40);
    assert.equal(e.value, 40);
    assert.ok(Math.abs(e.expected - 20.4) < 1);
    assert.ok(e.z > 3);
    assert.ok(e.pctOver > 0.5);
    assert.equal(e.excessKwh, e.value - e.expected);
    assert.equal(e.windowName, 'Tarde');
    assert.equal(e.baseline.n, stable.n);
    assert.equal(e.rulesVersion, DEFAULT_RULES.version);
  });

  test('piso de σ: setor extremamente estável não dispara por ruído', () => {
    const flat = pickBaseline(buildBaselineSet(afternoonSamples(15, () => 20), asOf, ctx()), 'tarde', 'weekday', 24)!;
    assert.equal(flat.sigma, 0);
    const e = evaluateValue(21, flat, tarde, 'weekday', DEFAULT_RULES, 15);
    assert.ok(e.sigma >= 2, 'σ efetivo respeita 10% da mediana');
    assert.equal(e.level, 'normal');
  });

  test('excesso absoluto mínimo: setor minúsculo não alerta por poucos kW', () => {
    const tiny = pickBaseline(buildBaselineSet(afternoonSamples(15, () => 0.05), asOf, ctx()), 'tarde', 'weekday', 24)!;
    const e = evaluateValue(0.3, tiny, tarde, 'weekday', DEFAULT_RULES, 15); // 6× a mediana, mas só ~1 kW
    assert.equal(e.level, 'normal');
  });

  test('envelope: setor liga/desliga não alerta no patamar "ligado" que já viu', () => {
    // 85% do tempo ~1 kWh, 15% do tempo ~20 kWh (equipamento que cicla)
    const duty = pickBaseline(buildBaselineSet(afternoonSamples(20, i => (i % 7 === 0 ? 20 : 1)), asOf, ctx()), 'tarde', 'weekday', 24)!;
    assert.ok(duty.median < 2);
    assert.equal(evaluateValue(20, duty, tarde, 'weekday', DEFAULT_RULES, 15).level, 'normal');
    assert.notEqual(evaluateValue(45, duty, tarde, 'weekday', DEFAULT_RULES, 15).level, 'normal');
  });

  test('contador inteiro: degrau de 1 kWh não é anomalia', () => {
    const q = pickBaseline(buildBaselineSet(afternoonSamples(15, () => 3), asOf, ctx(DEFAULT_RULES, 10)), 'tarde', 'weekday', 24)!;
    assert.equal(q.quantum, 1);
    assert.equal(evaluateValue(4, q, tarde, 'weekday', DEFAULT_RULES, 10).level, 'normal'); // +33%, mas só 1 degrau
  });

  test('multiplicador da faixa (troca de turno) torna o limite mais frouxo', () => {
    const base = evalAt(20);
    const loose = { ...tarde, thresholdMultiplier: 1.5 };
    const e = evalAt(20, stable, DEFAULT_RULES, loose);
    assert.ok(e.limits.atencao > base.limits.atencao);
  });

  test('mediana zero (setor desligado): não divide por zero e o piso absoluto vale', () => {
    const off = pickBaseline(buildBaselineSet(afternoonSamples(15, () => 0), asOf, ctx()), 'tarde', 'weekday', 24)!;
    const e = evaluateValue(0.1, off, tarde, 'weekday', DEFAULT_RULES, 15);
    assert.equal(e.level, 'normal');
    assert.ok(Number.isFinite(e.sigma) && Number.isFinite(e.limits.atencao));
  });

  test('o limite de cada nível é o maior entre as quatro condições (nunca menor que o envelope)', () => {
    const e = evalAt(20);
    assert.ok(e.limits.atencao >= e.envelope);
    assert.ok(e.limits.atencao >= e.expected * (1 + DEFAULT_RULES.levels.atencao.pct));
  });

  test('mediana do baseline bate com a mediana independente dos dados', () => {
    const samples = afternoonSamples(15, i => 20 + ((i * 7) % 5) * 0.2);
    assert.equal(stable.median, median(samples.map(s => s.kwh)));
  });
});
