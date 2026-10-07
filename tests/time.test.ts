import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestamp, localParts, dayTypeOf } from '../core/time.js';

const SP = 'America/Sao_Paulo';

describe('core/time', () => {
  test('interpreta timestamp local sem offset no fuso informado, independente do fuso do processo', () => {
    assert.equal(parseTimestamp('2026-09-24 16:45:00', SP)?.toISOString(), '2026-09-24T19:45:00.000Z');
    assert.equal(parseTimestamp('2026-09-24T16:45:00', SP)?.toISOString(), '2026-09-24T19:45:00.000Z');
  });

  test('timestamps absolutos (Z/offset) não são deslocados', () => {
    assert.equal(parseTimestamp('2026-09-24T19:45:00.000Z', SP)?.toISOString(), '2026-09-24T19:45:00.000Z');
    assert.equal(parseTimestamp('2026-09-24T16:45:00-03:00', SP)?.toISOString(), '2026-09-24T19:45:00.000Z');
  });

  test('inválidos viram null', () => {
    for (const s of ['', 'abc', '2026-13-45 99:99:99', '24/09/2026']) assert.equal(parseTimestamp(s, SP), null, s);
  });

  test('localParts devolve hora/dia da semana locais', () => {
    const p = localParts(new Date('2026-09-24T19:45:00Z'), SP); // quinta 16:45
    assert.equal(p.hour, 16);
    assert.equal(p.minuteOfDay, 16 * 60 + 45);
    assert.equal(p.weekday, 4);
    assert.equal(p.dateKey, '2026-09-24');
    assert.equal(dayTypeOf(p.weekday), 'weekday');
  });

  test('virada de dia respeita o fuso (00:30 local = 03:30Z)', () => {
    const p = localParts(new Date('2026-09-26T03:30:00Z'), SP); // sábado 00:30
    assert.equal(p.dateKey, '2026-09-26');
    assert.equal(dayTypeOf(p.weekday), 'weekend');
  });
});
