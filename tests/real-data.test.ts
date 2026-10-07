// Regressão com TELEMETRIA REAL do HCN (30/08–26/09/2026), incluindo o reinício da
// fonte de 24/09 16:30 que, na V1, gerou 8 alertas de R$ 2,1 milhões.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { loadUnitFromCsv } from '../scripts/lib/load.js';
import { replayUnit } from '../scripts/lib/replay.js';
import { parseCounter } from '../core/telemetry/parse.js';
import { UNITS } from '../core/units.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/hcn-restart-2026-09.csv.gz');
const loaded = loadUnitFromCsv('HCN', FIXTURE);

// 24/09/2026 16:30 BRT = 19:30Z
const EVENT_MS = Date.UTC(2026, 8, 24, 19, 30);

describe('HCN real — reinício de 24/09/2026', () => {
  test('o processamento da V1 (delta ingênuo, lixo → 0) de fato produzia o consumo absurdo', () => {
    const rows = Papa.parse<Record<string, string>>(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'), { header: true, skipEmptyLines: true }).data;
    rows.sort((a, b) => a.E3TimeStamp.localeCompare(b.E3TimeStamp));
    // V1: parseNumber devolvia 0 para "-"; delta negativo virava 0; a leitura seguinte = valor cheio − 0
    const v1 = (s: string) => parseCounter(s) ?? 0;
    let worst = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = v1(rows[i]['DJ7_Oncologia']) - v1(rows[i - 1]['DJ7_Oncologia']);
      if (d > worst) worst = d;
    }
    assert.ok(worst > 100_000, `V1 geraria um "consumo" de ${Math.round(worst)} kWh em 15 min`);
  });

  test('a normalização nunca grava consumo de intervalo absurdo e detecta o reinício', () => {
    const max = Math.max(...loaded.readings.filter(r => r.intervalKwh !== null).map(r => r.intervalKwh as number));
    assert.ok(max < 100, `maior consumo por intervalo: ${max}`);
    const ev = loaded.events.find(e => Math.abs(e.ts.getTime() - EVENT_MS) <= 15 * 60000);
    assert.ok(ev, 'evento de fonte detectado em 24/09 16:30');
    assert.ok(ev!.affectedSectors >= 7, `${ev!.affectedSectors} medidores afetados`);
    const after = loaded.readings.filter(r => r.sectorCode === 'DJ7_Oncologia' && r.ts.getTime() > EVENT_MS && r.ts.getTime() <= EVENT_MS + 45 * 60000);
    assert.ok(after.some(r => r.status === 'quarantined'), 'leituras seguintes em quarentena (estabilização)');
  });

  test('backtest: nenhum alerta nasce do reinício e o volume é baixo', () => {
    const result = replayUnit(loaded, { days: 14 });
    const nearEvent = result.incidents.filter(i => i.openedAt.getTime() >= EVENT_MS - 15 * 60000 && i.openedAt.getTime() <= EVENT_MS + 3 * 3600000);
    assert.deepEqual(nearEvent, [], 'nenhum incidente aberto nas 3 h seguintes ao reinício');
    assert.ok(result.incidents.every(i => i.excessKwh < 500), 'nenhum incidente com excedente absurdo');
    const days = 14;
    assert.ok(result.messages.length / days <= 2, `${result.messages.length} mensagens em ${days} dias`);
    assert.ok(result.incidents.length / days <= 3, `${result.incidents.length} incidentes em ${days} dias`);
  });

  test('o mesmo período, com o motor V1, teria gerado dezenas de eventos', () => {
    // referência (medida em 07/10/2026 sobre 14 dias): 870 eventos / 40% dos ciclos com alerta.
    // Aqui só registramos que o motor atual está pelo menos uma ordem de grandeza abaixo.
    const result = replayUnit(loaded, { days: 14 });
    assert.ok(result.messages.length < 87);
  });

  test('o registro de unidades cobre todas as colunas de setor da planilha real', () => {
    const header = Object.keys(Papa.parse<Record<string, string>>(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'), { header: true, preview: 1 }).data[0] ?? {});
    const columns = header.filter(c => c !== 'E3TimeStamp' && !c.endsWith('_Quality'));
    assert.deepEqual([...columns].sort(), UNITS.HCN.sectors.map(s => s.sourceColumn).sort());
  });
});
