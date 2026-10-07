// Testes de integração do ciclo completo (ingestão → normalização → motor →
// alertas → notificações) sobre PostgreSQL real (PGlite) com telemetria simulada
// reproduzindo os problemas do campo.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetOperationalData } from '../scripts/lib/pgliteDb.js';
import { runCycle, type CycleDeps } from '../api/services/cycle.js';
import { silentLogger } from '../api/infra/logger.js';
import type { Db } from '../api/infra/db.js';
import { FakeNotifier, SimSource, UNITS } from './sim.js';

const START = new Date(Date.UTC(2026, 8, 1, 3, 0, 0)); // 2026-09-01 00:00 BRT
const HISTORY_TICKS = 96 * 9; // 9 dias de histórico para formar baseline

let db: Db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

interface Harness {
  sim: SimSource;
  notifier: FakeNotifier;
  deps: CycleDeps;
  clock: { now: Date };
  cycle(opts?: Parameters<typeof runCycle>[2]): ReturnType<typeof runCycle>;
}

async function harness(unit: 'HCN' | 'HMB', seed = 1, shadow = false, reset = true): Promise<Harness> {
  if (reset) await resetOperationalData(db);
  const sim = new SimSource(UNITS[unit], START, seed);
  const notifier = new FakeNotifier();
  const clock = { now: START };
  const deps: CycleDeps = { db, source: sim, notifier, log: silentLogger, now: () => clock.now, shadow };
  const ticksPerDay = (24 * 60) / UNITS[unit].expectedIntervalMin;
  sim.ticks(Math.round((HISTORY_TICKS / 96) * ticksPerDay));
  clock.now = new Date(sim.now.getTime() + 60000);
  const h: Harness = {
    sim, notifier, deps, clock,
    cycle: opts => runCycle(deps, unit, opts),
  };
  const first = await h.cycle({ sheetLimit: 'all' }); // carga inicial do histórico
  assert.equal(first.status, 'ok');
  return h;
}

/** avança um intervalo e roda o ciclo 1 min depois do dado, como o gatilho real */
async function step(h: Harness, opts: Parameters<SimSource['tick']>[0] = {}) {
  h.sim.tick(opts);
  h.clock.now = new Date(h.sim.now.getTime() + 60000);
  return h.cycle();
}

const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n;

describe('ciclo — operação normal', () => {
  test('carga inicial grava as leituras normalizadas, sem alertas nem mensagens', async () => {
    const h = await harness('HCN');
    const readings = await count("SELECT count(*)::int n FROM readings r JOIN units u ON u.id = r.unit_id WHERE u.code = 'HCN'");
    assert.equal(readings, UNITS.HCN.sectors.length * HISTORY_TICKS, 'todas as leituras de todos os setores, uma vez');
    assert.equal(h.notifier.sent.length, 0);
    assert.equal(await count("SELECT count(*)::int n FROM alerts a JOIN units u ON u.id = a.unit_id WHERE u.code = 'HCN'"), 0);
  });

  test('semana inteira de operação normal não gera alerta nem mensagem (sem falso positivo)', async () => {
    const h = await harness('HMB', 7);
    let opened = 0;
    for (let i = 0; i < 6 * 24; i++) {
      const r = await step(h);
      opened += r.evaluation.opened;
    }
    assert.equal(opened, 0);
    assert.equal(h.notifier.sent.length, 0);
  });

  test('ciclos sucessivos não corrompem leituras já calculadas (só a primeira de cada setor é "baseline")', async () => {
    const h = await harness('HCN', 2);
    for (let i = 0; i < 12; i++) await step(h);
    const bad = await count(
      `SELECT count(*)::int n FROM (SELECT sector_id FROM readings WHERE status = 'baseline' GROUP BY sector_id HAVING count(*) > 1) t`
    );
    assert.equal(bad, 0);
    const nullIntervals = await count("SELECT count(*)::int n FROM readings WHERE status = 'ok' AND interval_kwh IS NULL");
    assert.equal(nullIntervals, 0);
  });

  test('rodar o ciclo duas vezes sobre os mesmos dados é idempotente', async () => {
    const h = await harness('HCN', 3);
    await step(h);
    const again = await h.cycle();
    assert.equal(again.status, 'skipped');
    assert.equal(again.skipped, 'no_new_data');
    assert.equal(again.evaluation.readings, 0);
  });
});

describe('ciclo — anomalia real', () => {
  test('aumento sustentado abre UM alerta, notifica UMA vez, não repete e recupera', async () => {
    const h = await harness('HCN', 11);
    const code = 'DJ40_Refeitorio';
    const opened: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await step(h, { factor: { [code]: 2.6 } });
      opened.push(r.evaluation.opened);
    }
    assert.equal(opened.reduce((a, b) => a + b, 0), 1, 'um único alerta');
    assert.equal(h.notifier.sent.length, 1, 'uma única mensagem, mesmo com 8 ciclos anômalos seguidos');
    assert.match(h.notifier.sent[0].params[1], /^HCN - REFEITÓRIO/, 'a unidade aparece na mensagem');

    // volta ao normal → recupera depois de N leituras
    for (let i = 0; i < 5; i++) await step(h);
    const row = (await db.query<{ status: string; severity: string; breach_count: number; total_excess_kwh: number; total_cost_brl: number; notification_count: number }>(
      `SELECT a.status, a.severity, a.breach_count, a.total_excess_kwh, a.total_cost_brl, a.notification_count
         FROM alerts a JOIN units u ON u.id = a.unit_id JOIN sectors s ON s.id = a.sector_id WHERE u.code = 'HCN' AND s.code = $1`,
      [code]
    )).rows[0];
    assert.equal(row.status, 'recovered');
    assert.ok(row.breach_count >= 6);
    assert.ok(row.total_excess_kwh > 0 && row.total_cost_brl > 0);
    assert.equal(row.notification_count, 1);
  });

  test('cada evento do alerta carrega a explicação (valor, esperado, limite, regra, faixa)', async () => {
    const h = await harness('HCN', 12);
    for (let i = 0; i < 4; i++) await step(h, { factor: { DJ60_RM: 3 } });
    const ev = (await db.query<{ type: string; value_kwh: number; expected_kwh: number; limit_kwh: number; explain: any }>(
      `SELECT e.type, e.value_kwh, e.expected_kwh, e.limit_kwh, e.explain FROM alert_events e
         JOIN alerts a ON a.id = e.alert_id JOIN sectors s ON s.id = a.sector_id WHERE s.code = 'DJ60_RM' AND e.type = 'opened'`
    )).rows[0];
    assert.ok(ev, 'evento opened registrado');
    assert.ok(ev.value_kwh > ev.limit_kwh && ev.limit_kwh > ev.expected_kwh);
    assert.equal(typeof ev.explain.reason, 'string');
    assert.ok(ev.explain.window.name.length > 0);
    assert.ok(ev.explain.baseline.n >= 24);
    assert.equal(ev.explain.persistence.required, 2);
    assert.match(ev.explain.reason, /acima do esperado/);
  });

  test('pico isolado de uma só leitura não abre alerta', async () => {
    const h = await harness('HMB', 5);
    await step(h, { factor: { ME_QGBT_E_16_hmb: 5 } });
    for (let i = 0; i < 4; i++) await step(h);
    assert.equal(h.notifier.sent.length, 0);
    assert.equal(await count("SELECT count(*)::int n FROM alerts a JOIN sectors s ON s.id = a.sector_id WHERE s.code = 'ME_QGBT_E_16_hmb'"), 0);
  });

  test('vários setores anômalos no mesmo ciclo saem em UMA mensagem (resumo)', async () => {
    const h = await harness('HCN', 21);
    const factor = { DJ40_Refeitorio: 2.6, DJ60_RM: 2.8, SADT: 2.5 };
    for (let i = 0; i < 4; i++) await step(h, { factor });
    assert.equal(h.notifier.sent.length, 1);
    assert.match(h.notifier.sent[0].params[1], /\(\+2 setores\)/);
    assert.match(h.notifier.sent[0].params[7], /Também acima do esperado/);
    assert.equal(await count('SELECT count(*)::int n FROM notification_alerts na JOIN notifications n ON n.id = na.notification_id JOIN units u ON u.id = n.unit_id WHERE u.code = $1', ['HCN']) >= 3, true, 'a mensagem cobre os 3 alertas');
  });
});

describe('ciclo — falhas de dados e de infraestrutura', () => {
  test('REINÍCIO DA FONTE (incidente de 24/09): zeros/"-" por uma leitura não geram alerta nem envenenam o baseline', async () => {
    const h = await harness('HCN', 31);
    await step(h, { restart: true });
    const r = await step(h); // contadores voltam — V1 calculava delta de ~100.000 kWh aqui
    for (let i = 0; i < 6; i++) await step(h);
    assert.equal(h.notifier.sent.length, 0, 'nenhuma mensagem');
    assert.equal(await count("SELECT count(*)::int n FROM alerts a JOIN units u ON u.id = a.unit_id WHERE u.code = 'HCN'"), 0, 'nenhum alerta');
    assert.ok((await count("SELECT count(*)::int n FROM system_events e JOIN units u ON u.id = e.unit_id WHERE u.code = 'HCN' AND e.kind = 'source_event'")) >= 1, 'evento de fonte registrado');
    const maxInterval = (await db.query<{ m: number }>("SELECT max(r.interval_kwh) m FROM readings r JOIN units u ON u.id = r.unit_id WHERE u.code = 'HCN'")).rows[0].m;
    assert.ok(maxInterval < 200, `nenhum consumo de intervalo absurdo gravado (máx ${maxInterval})`);
    assert.ok(r.normalize.sourceEvents >= 0);
    const quarantined = await count("SELECT count(*)::int n FROM readings r JOIN units u ON u.id = r.unit_id WHERE u.code = 'HCN' AND r.status = 'quarantined'");
    assert.ok(quarantined > 0, 'leituras de estabilização em quarentena');
  });

  test('fonte parada: sem dado novo por horas ⇒ evento source_stale, nenhuma mensagem de consumo; retomada registrada', async () => {
    const h = await harness('HMB', 41);
    await step(h);
    h.clock.now = new Date(h.sim.now.getTime() + 3 * 3600000); // 3 h sem dados novos
    const r = await h.cycle();
    assert.equal(r.source.status, 'stale');
    assert.equal(h.notifier.sent.length, 0);
    assert.equal(await count("SELECT count(*)::int n FROM system_events e JOIN units u ON u.id = e.unit_id WHERE u.code = 'HMB' AND e.kind = 'source_stale'"), 1);
    await step(h); // volta
    assert.equal(await count("SELECT count(*)::int n FROM system_events e JOIN units u ON u.id = e.unit_id WHERE u.code = 'HMB' AND e.kind = 'source_resumed'"), 1);
  });

  test('retorno após queda: a lacuna não vira pico e as leituras do retorno ficam fora do baseline', async () => {
    const h = await harness('HCN', 51);
    h.sim.ticks(10, { unpublished: true }); // 2h30 sem publicar
    const r = await step(h);
    const stale = await count("SELECT count(*)::int n FROM readings rd JOIN units u ON u.id = rd.unit_id WHERE u.code = 'HCN' AND rd.status = 'stale_gap'");
    assert.ok(stale >= UNITS.HCN.sectors.length, 'leitura que atravessa a lacuna fica sem intervalo');
    assert.equal(r.evaluation.opened, 0);
    assert.equal(h.notifier.sent.length, 0);
  });

  test('WhatsApp indisponível: falha registrada, aviso NÃO é perdido e é reenviado no ciclo seguinte', async () => {
    const h = await harness('HCN', 61);
    h.notifier.failNext = 1;
    let failed = 0;
    for (let i = 0; i < 3; i++) failed += (await step(h, { factor: { SADT: 3 } })).notifications.failed;
    assert.equal(failed, 1);
    const n = (await db.query<{ status: string; error: string | null }>(
      "SELECT n.status, n.error FROM notifications n JOIN units u ON u.id = n.unit_id WHERE u.code = 'HCN' ORDER BY n.id"
    )).rows;
    assert.equal(n[0].status, 'failed');
    assert.match(n[0].error ?? '', /Nenhum destinatário/);
    // o motor volta a propor o aviso (alerta continua aberto e nunca foi notificado de fato)
    for (let i = 0; i < 2; i++) await step(h, { factor: { SADT: 3 } });
    assert.equal(h.notifier.sent.length, 1, 'reenviado e entregue');
    const final = (await db.query<{ status: string }>("SELECT n.status FROM notifications n JOIN units u ON u.id = n.unit_id WHERE u.code = 'HCN' ORDER BY n.id")).rows;
    assert.deepEqual(final.map(x => x.status), ['failed', 'sent']);
  });

  test('modo sombra: tudo é avaliado e gravado, mas nenhuma mensagem sai', async () => {
    const h = await harness('HCN', 71, true);
    for (let i = 0; i < 4; i++) await step(h, { factor: { DJ40_Refeitorio: 3 } });
    assert.equal(h.notifier.sent.length, 0);
    const n = (await db.query<{ status: string; suppress_reason: string }>("SELECT status, suppress_reason FROM notifications")).rows;
    assert.ok(n.some(x => x.status === 'suppressed' && x.suppress_reason === 'shadow_mode'));
  });

  test('destinatários não configurados: alerta é registrado e a notificação fica suprimida com o motivo', async () => {
    const h = await harness('HMB', 81);
    h.notifier.configured = false;
    for (let i = 0; i < 6; i++) await step(h, { factor: { ME_QGBT_E_16_hmb: 3 } });
    const n = (await db.query<{ status: string; suppress_reason: string }>(
      "SELECT n.status, n.suppress_reason FROM notifications n JOIN units u ON u.id = n.unit_id WHERE u.code = 'HMB'"
    )).rows;
    assert.ok(n.length >= 1 && n.every(x => x.status === 'suppressed' && x.suppress_reason === 'not_configured'));
  });

  test('dados fora de ordem e linhas duplicadas na fonte não quebram nem duplicam leituras', async () => {
    const h = await harness('HCN', 91);
    for (let i = 0; i < 3; i++) h.sim.tick();
    // embaralha a ordem e duplica a linha mais recente
    const rows = h.sim.rows;
    const last = rows[rows.length - 1];
    rows.splice(rows.length - 3, 3, rows[rows.length - 1], rows[rows.length - 3], rows[rows.length - 2], last);
    h.clock.now = new Date(h.sim.now.getTime() + 60000);
    const before = await count("SELECT count(*)::int n FROM readings r JOIN units u ON u.id = r.unit_id WHERE u.code = 'HCN'");
    const r = await h.cycle();
    assert.equal(r.status, 'ok');
    const after = await count("SELECT count(*)::int n FROM readings r JOIN units u ON u.id = r.unit_id WHERE u.code = 'HCN'");
    assert.equal(after - before, 3 * UNITS.HCN.sectors.length, 'exatamente as 3 leituras novas × setores');
  });
});

describe('ciclo — várias unidades simultâneas', () => {
  test('HCN e HMB processados em paralelo nunca trocam registros entre si', async () => {
    const a = await harness('HCN', 101);
    const b = await harness('HMB', 102, false, false);
    for (let i = 0; i < 4; i++) {
      a.sim.tick({ factor: { DJ60_RM: 3 } });
      b.sim.tick({ factor: { ME_QGBT_E_16_hmb: 3 } });
      a.clock.now = new Date(a.sim.now.getTime() + 60000);
      b.clock.now = new Date(b.sim.now.getTime() + 60000);
      await Promise.all([a.cycle(), b.cycle()]);
    }
    const rows = (await db.query<{ unit: string; sector: string }>(
      "SELECT u.code AS unit, s.code AS sector FROM alerts a JOIN units u ON u.id = a.unit_id JOIN sectors s ON s.id = a.sector_id"
    )).rows;
    const hcn = rows.filter(r => r.unit === 'HCN').map(r => r.sector);
    const hmb = rows.filter(r => r.unit === 'HMB').map(r => r.sector);
    assert.ok(hcn.includes('DJ60_RM') && !hcn.some(s => s.endsWith('_hmb')));
    assert.ok(hmb.includes('ME_QGBT_E_16_hmb') && !hmb.some(s => s.startsWith('DJ')));
    // cada mensagem fala da sua unidade
    assert.ok(a.notifier.sent.every(m => m.unitCode === 'HCN' && m.params[1].startsWith('HCN - ')));
    assert.ok(b.notifier.sent.every(m => m.unitCode === 'HMB' && m.params[1].startsWith('HMB - ')));
  });
});
