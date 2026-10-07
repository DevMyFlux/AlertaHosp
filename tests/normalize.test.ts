import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSamples, isEvaluable, isBaselineEligible } from '../core/telemetry/normalize.js';
import { parseCounter, parseSheetRows } from '../core/telemetry/parse.js';
import { UNITS } from '../core/units.js';
import { makeSamples, every } from './helpers.js';

const opts = { expectedIntervalMin: 15 };
const byKey = (res: ReturnType<typeof normalizeSamples>, code: string) =>
  res.readings.filter(r => r.sectorCode === code);

describe('parseCounter', () => {
  test('aceita pt-BR, ponto decimal e inteiros', () => {
    assert.equal(parseCounter('254356,2969'), 254356.2969);
    assert.equal(parseCounter('1.234.567,89'), 1234567.89);
    assert.equal(parseCounter('4942192'), 4942192);
    assert.equal(parseCounter('123.45'), 123.45);
    assert.equal(parseCounter(12.5), 12.5);
  });

  test('NUNCA devolve 0 para lixo: vazio, "-", texto, NaN viram null', () => {
    for (const bad of ['', ' ', '-', 'abc', 'NaN', 'Infinity', null, undefined, NaN, '1,2,3']) {
      assert.equal(parseCounter(bad as unknown), null, String(bad));
    }
    assert.equal(parseCounter('0'), 0); // zero legítimo continua zero
  });
});

describe('normalizeSamples — leitura normal', () => {
  test('delta entre leituras consecutivas, primeira é baseline', () => {
    const s = makeSamples(every(15, 4), [{ A: 100 }, { A: 110 }, { A: 125.5 }, { A: 125.5 }]);
    const r = byKey(normalizeSamples(s, ['A'], opts), 'A');
    assert.deepEqual(r.map(x => x.status), ['baseline', 'ok', 'ok', 'ok']);
    assert.deepEqual(r.map(x => x.intervalKwh), [null, 10, 15.5, 0]);
    assert.ok(r.slice(1).every(isEvaluable));
    assert.ok(r.slice(1).every(isBaselineEligible));
  });

  test('jitter de segundos (HMB, 10 min) não é tratado como lacuna', () => {
    const s = makeSamples([0, 10.02, 20.03, 31], [{ A: 0 }, { A: 5 }, { A: 11 }, { A: 18 }]);
    const r = byKey(normalizeSamples(s, ['A'], { expectedIntervalMin: 10 }), 'A');
    assert.deepEqual(r.map(x => x.status), ['baseline', 'ok', 'ok', 'ok']);
    assert.equal(r[3].intervalKwh, 7); // 10,97 min ≤ 12,5 ⇒ sem reescala
  });
});

describe('normalizeSamples — reinício da fonte (incidente de 24/09/2026)', () => {
  // Dados reais do HCN: 16:15 normal, 16:30 "-"/0 (e SADT em outro contador), 16:45 de volta.
  const sectors = ['ONC', 'REF', 'LAB', 'SADT', 'OK1', 'OK2'];
  const rows = [
    { ONC: 194924.5, REF: 675949.4, LAB: 135590.3, SADT: 814067.0, OK1: 1000, OK2: 2000 },
    { ONC: 194925.968, REF: 675953.8, LAB: 135591.7, SADT: 814073.9, OK1: 1002, OK2: 2003 },
    { ONC: null, REF: null, LAB: null, SADT: 24710.9, OK1: 1004, OK2: 2006 },
    { ONC: 194929.015, REF: 675964.1, LAB: 135594.6, SADT: 814083.5, OK1: 1006, OK2: 2009 },
    { ONC: 194930.437, REF: 675969.2, LAB: 135596.1, SADT: 814086.8, OK1: 1008, OK2: 2012 },
    { ONC: 194931.906, REF: 675974.5, LAB: 135597.4, SADT: 814091.8, OK1: 1010, OK2: 2015 },
    { ONC: 194933.4, REF: 675979.9, LAB: 135598.8, SADT: 814096.0, OK1: 1012, OK2: 2018 },
  ];
  const res = normalizeSamples(makeSamples(every(15, rows.length), rows), sectors, opts);

  test('nenhum setor produz consumo gigante', () => {
    for (const r of res.readings) {
      if (r.intervalKwh !== null) assert.ok(r.intervalKwh < 50, `${r.sectorCode}@${r.ts.toISOString()} = ${r.intervalKwh}`);
    }
  });

  test('o instante do reinício vira evento de fonte', () => {
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].affectedSectors, 4); // ONC, REF, LAB (nulos) + SADT (regressão)
    const onc = byKey(res, 'ONC');
    assert.equal(onc[2].status, 'invalid');
    assert.ok(onc[2].flags.includes('source_event'));
  });

  test('SADT: queda de 97% é descartada como glitch (não vira reset)', () => {
    const sadt = byKey(res, 'SADT');
    assert.ok(sadt[2].flags.includes('counter_regression'));
    assert.ok(sadt[2].flags.includes('glitch_discarded'));
    assert.notEqual(sadt[2].status, 'reset');
  });

  test('as 2 leituras seguintes ficam em quarentena (estabilização) e depois voltam ao normal', () => {
    const onc = byKey(res, 'ONC');
    assert.deepEqual(onc.map(r => r.status), ['baseline', 'ok', 'invalid', 'quarantined', 'quarantined', 'ok', 'ok']);
    // a leitura que atravessa o buraco tem span de 30 min e é reescalada para 15
    assert.equal(onc[3].spanMinutes, 30);
    assert.ok(Math.abs((onc[3].intervalKwh ?? 0) - (194929.015 - 194925.968) / 2) < 1e-6);
    // setores sem problema não são afetados antes do evento
    assert.equal(byKey(res, 'OK1')[2].status, 'ok');
  });
});

describe('normalizeSamples — falhas isoladas de um setor', () => {
  test('um setor com valor 0 por uma leitura (sem evento de fonte) é glitch descartado', () => {
    const rows = [
      { A: 500, B: 10, C: 20, D: 30 },
      { A: 510, B: 20, C: 30, D: 40 },
      { A: 0, B: 30, C: 40, D: 50 },
      { A: 530, B: 40, C: 50, D: 60 },
    ];
    const res = normalizeSamples(makeSamples(every(15, 4), rows), ['A', 'B', 'C', 'D'], opts);
    assert.equal(res.events.length, 0);
    const a = byKey(res, 'A');
    assert.equal(a[2].status, 'invalid');
    assert.ok(a[2].flags.includes('glitch_discarded'));
    assert.equal(a[3].status, 'gap');
    assert.equal(a[3].intervalKwh, 10); // (530−510)/2 por intervalo
    assert.ok(isEvaluable(a[3]) && !isBaselineEligible(a[3]));
  });

  test('reset real: contador recomeça de 0 e sobe — é re-baselinado, sem delta gigante', () => {
    const rows = [{ A: 1000 }, { A: 1010 }, { A: 0 }, { A: 7 }, { A: 15 }];
    const a = byKey(normalizeSamples(makeSamples(every(15, 5), rows), ['A'], opts), 'A');
    assert.deepEqual(a.map(r => r.status), ['baseline', 'ok', 'reset', 'ok', 'ok']);
    assert.deepEqual(a.map(r => r.intervalKwh), [null, 10, null, 7, 8]);
  });

  test('travado em zero por horas e depois volta ao valor real: nunca vira reset nem consumo', () => {
    const rows = [{ A: 5000 }, { A: 5010 }, { A: 0 }, { A: 0 }, { A: 0 }, { A: 0 }, { A: 0 }, { A: 5040 }, { A: 5050 }];
    const a = byKey(normalizeSamples(makeSamples(every(15, 9), rows), ['A'], opts), 'A');
    assert.ok(a.slice(2, 7).every(r => r.status === 'invalid'));
    assert.equal(a[7].status, 'stale_gap'); // 90 min sem referência confiável
    assert.equal(a[7].intervalKwh, null);
    assert.equal(a[8].intervalKwh, 10);
  });

  test('regressão minúscula (ruído de medidor) não gera consumo nem glitch', () => {
    const rows = [{ A: 136274.546 }, { A: 136272.14 }, { A: 136274.28 }];
    const a = byKey(normalizeSamples(makeSamples(every(15, 3), rows), ['A'], opts), 'A');
    assert.ok(a[1].flags.includes('small_regression'));
    assert.equal(a[1].intervalKwh, null);
    assert.ok(Math.abs((a[2].intervalKwh ?? 0) - 2.14) < 1e-6);
  });

  test('Quality ≠ 192 invalida a leitura mesmo com valor plausível', () => {
    const rows = [{ A: 100 }, { A: [110, 0] as [number, number] }, { A: 120 }];
    const a = byKey(normalizeSamples(makeSamples(every(15, 3), rows), ['A'], opts), 'A');
    assert.equal(a[1].status, 'invalid');
    assert.ok(a[1].flags.includes('bad_quality'));
    assert.equal(a[2].status, 'gap');
    assert.equal(a[2].intervalKwh, 10);
  });

  test('valor negativo e ausente são inválidos', () => {
    const a = byKey(normalizeSamples(makeSamples(every(15, 3), [{ A: 100 }, { A: -5 }, { A: null }]), ['A'], opts), 'A');
    assert.deepEqual(a.map(r => r.status), ['baseline', 'invalid', 'invalid']);
  });
});

describe('normalizeSamples — lacunas e fonte parada', () => {
  test('lacuna de 30 min: consumo normalizado para 15 min e marcado gap', () => {
    const a = byKey(normalizeSamples(makeSamples([0, 15, 45, 60], [{ A: 0 }, { A: 10 }, { A: 40 }, { A: 50 }]), ['A'], opts), 'A');
    assert.equal(a[2].status, 'gap');
    assert.equal(a[2].intervalKwh, 15);
    assert.equal(a[3].status, 'ok');
  });

  test('lacuna longa (105 min, como em 20/08 no HCN) não é avaliável', () => {
    const a = byKey(normalizeSamples(makeSamples([0, 15, 120], [{ A: 0 }, { A: 10 }, { A: 150 }]), ['A'], opts), 'A');
    assert.equal(a[2].status, 'stale_gap');
    assert.equal(a[2].intervalKwh, null);
    assert.equal(a[2].deltaKwh, 140);
    assert.ok(!isEvaluable(a[2]));
  });

  test('falha de sensor prolongada em 2 setores (como E_19/E_28 do HMB) não gera evento de fonte', () => {
    const bad = (i: number): [number, number] => (i >= 1 && i <= 4 ? [0, 0] : [i * 5, 192]);
    const rows = Array.from({ length: 6 }, (_, i) => ({ A: i * 5, B: i * 5, C: i * 5, D: i * 5, E: bad(i), F: bad(i) }));
    const res = normalizeSamples(makeSamples(every(10, 6), rows), ['A', 'B', 'C', 'D', 'E', 'F'], { expectedIntervalMin: 10 });
    assert.equal(res.events.length, 0);
    assert.equal(byKey(res, 'A').filter(r => r.status === 'ok').length, 5);
  });
});

describe('parseSheetRows', () => {
  const row = (ts: string, v: string) => ({ E3TimeStamp: ts, ME_CME_hmb: v, ME_CME_hmb_Quality: '192' });

  test('ordena (a planilha insere no topo), deduplica e conta rejeitadas', () => {
    const parsed = parseSheetRows(
      [row('2026-10-07 10:39:43', '254356,2969'), row('2026-10-07 10:29:43', '254354,06'), row('2026-10-07 10:29:43', '254354,07'), row('lixo', '1')],
      UNITS.HMB
    );
    assert.equal(parsed.samples.length, 2);
    assert.equal(parsed.rejectedRows, 1);
    assert.equal(parsed.duplicateRows, 1);
    assert.ok(parsed.samples[0].ts < parsed.samples[1].ts);
    assert.equal(parsed.samples[0].values.ME_CME_hmb.counter, 254354.07); // vale a última ocorrência
  });

  test('timestamp local de São Paulo vira UTC correto (+3h)', () => {
    const parsed = parseSheetRows([row('2026-09-24 16:45:00', '1')], UNITS.HCN);
    assert.equal(parsed.samples[0].ts.toISOString(), '2026-09-24T19:45:00.000Z');
  });

  test('coluna com "." inicial (.ME_CLIM_UTI) é mapeada para o código canônico', () => {
    const parsed = parseSheetRows(
      [{ E3TimeStamp: '2026-09-24 16:45:00', '.ME_CLIM_UTI': '12,5', '.ME_CLIM_UTI_Quality': '192' }],
      UNITS.HCN
    );
    assert.equal(parsed.samples[0].values.ME_CLIM_UTI.counter, 12.5);
    assert.equal(parsed.samples[0].values.ME_CLIM_UTI.quality, 192);
  });
});
