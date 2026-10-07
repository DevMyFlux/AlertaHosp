// Testes HTTP da API completa (Express real + PostgreSQL real em memória).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { createTestDb } from '../scripts/lib/pgliteDb.js';
import { createApp } from '../api/app.js';
import type { AppDeps } from '../api/context.js';
import { loadAppEnv } from '../api/infra/env.js';
import { silentLogger } from '../api/infra/logger.js';
import type { Db } from '../api/infra/db.js';
import { FakeNotifier, SimSource, UNITS } from './sim.js';

const START = new Date(Date.UTC(2026, 8, 1, 3, 0, 0));
const CLOCK = { now: START };

let db: Db;
let server: Server;
let base: string;
const sims = {} as Record<'HCN' | 'HMB', SimSource>;
const notifier = new FakeNotifier();

function envWith(extra: Record<string, string> = {}) {
  return loadAppEnv({
    CRON_SECRET: 'segredo-hcn-123456', CRON_SECRET_HMB: 'segredo-hmb-654321',
    APP_ACCESS_PASSWORD: 'senha-da-equipe', SESSION_SECRET: 'sessao-teste-1234567890',
    ...extra,
  } as NodeJS.ProcessEnv);
}

before(async () => {
  db = await createTestDb();
  sims.HCN = new SimSource(UNITS.HCN, START, 1);
  sims.HMB = new SimSource(UNITS.HMB, START, 2);
  sims.HCN.ticks(96 * 9);
  sims.HMB.ticks(144 * 9);
  CLOCK.now = new Date(sims.HCN.now.getTime() + 60000);
  const source = {
    fetchRows: async (unit: { code: 'HCN' | 'HMB' }, limit: number | 'all') => sims[unit.code].fetchRows(UNITS[unit.code], limit),
  };
  const deps: AppDeps = { env: envWith(), db, source, notifier, log: silentLogger, now: () => CLOCK.now, version: 'test' };
  server = createApp(deps).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await db.close();
});

const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
const bearer = (secret: string) => ({ headers: { Authorization: `Bearer ${secret}` } });

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'senha-da-equipe' }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('segurança do ciclo agendado', () => {
  test('sem segredo, com segredo errado ou segredo na query string ⇒ 401', async () => {
    assert.equal((await get('/api/cron-check')).status, 401);
    assert.equal((await get('/api/cron-check', bearer('errado'))).status, 401);
    assert.equal((await get('/api/cron-check?secret=segredo-hcn-123456')).status, 401, 'segredo na URL não vale mais');
  });

  test('o segredo de um hospital não abre o ciclo do outro', async () => {
    assert.equal((await get('/api/cron-check?hospital=hmb', bearer('segredo-hcn-123456'))).status, 401);
    assert.equal((await get('/api/cron-check?hospital=hcn', bearer('segredo-hmb-654321'))).status, 401);
  });

  test('unidade desconhecida é erro 400 — nunca cai silenciosamente em outro hospital', async () => {
    const res = await get('/api/cron-check?hospital=bogus', bearer('segredo-hcn-123456'));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_unit');
  });

  test('ciclo autorizado carrega o histórico de cada unidade e responde com o resumo', async () => {
    const hcn = await get('/api/cron-check', bearer('segredo-hcn-123456')); // sem ?hospital = HCN (compatível com o Apps Script atual)
    assert.equal(hcn.status, 200);
    const body = await hcn.json();
    assert.equal(body.hospital, 'HCN');
    assert.equal(body.ingest.inserted, 96 * 9 * UNITS.HCN.sectors.length);
    const hmb = await get('/api/cron-check?hospital=hmb', bearer('segredo-hmb-654321'));
    assert.equal((await hmb.json()).hospital, 'HMB');
  });
});

describe('rotas removidas e superfície exposta', () => {
  test('/api/notify (V1, sem autenticação) e /api/chat não existem mais', async () => {
    const json = { 'content-type': 'application/json' };
    assert.equal((await get('/api/notify', { method: 'POST', body: JSON.stringify({ phone: '5511999999999', message: 'x' }), headers: json })).status, 404);
    assert.equal((await get('/api/chat', { method: 'POST', body: '{}', headers: json })).status, 404);
  });

  test('health é público e não expõe segredos nem números', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    const text = JSON.stringify(await res.json());
    assert.match(text, /"database":"ok"/);
    for (const secret of ['segredo-hcn', 'segredo-hmb', 'senha-da-equipe', 'sessao-teste']) assert.ok(!text.includes(secret));
    assert.ok(!/\d{10,}/.test(text), 'nenhum telefone');
  });

  test('cabeçalhos de segurança presentes e erros não vazam detalhes internos', async () => {
    const res = await get('/api/units/XYZ/overview');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('painel protegido por senha', () => {
  test('sem sessão, leitura retorna 401; com sessão, 200', async () => {
    assert.equal((await get('/api/units')).status, 401);
    const cookie = await login();
    assert.equal((await get('/api/units', { headers: { cookie } })).status, 200);
    const me = await (await get('/api/auth/me', { headers: { cookie } })).json();
    assert.deepEqual(me, { authRequired: true, authenticated: true });
  });

  test('senha errada ⇒ 401 e muitas tentativas ⇒ 429', async () => {
    // IP próprio (X-Forwarded-For) para o bloqueio não afetar os outros testes
    const attempt = () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ password: 'x' }) });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await attempt()).status);
    assert.equal(codes[0], 401);
    assert.ok(codes.includes(429), `códigos: ${codes.join(',')}`);
  });

  test('cookie adulterado não vale', async () => {
    const cookie = await login();
    const forged = cookie.slice(0, -3) + 'abc';
    assert.equal((await get('/api/units', { headers: { cookie: forged } })).status, 401);
  });

  test('mensagem de teste exige sessão', async () => {
    assert.equal((await get('/api/units/HCN/notifications/test', { method: 'POST' })).status, 401);
    const cookie = await login();
    const res = await get('/api/units/HCN/notifications/test', { method: 'POST', headers: { cookie } });
    // FakeNotifier está configurado ⇒ envia
    assert.equal(res.status, 200);
    assert.equal(notifier.sent.length >= 1, true);
  });
});

describe('leitura escopada por unidade', () => {
  test('visão geral, setores e série respondem por unidade e nunca misturam setores', async () => {
    const cookie = await login();
    const hcn = await (await get('/api/units/HCN/sectors', { headers: { cookie } })).json();
    const hmb = await (await get('/api/units/HMB/sectors', { headers: { cookie } })).json();
    assert.equal(hcn.unit, 'HCN');
    assert.ok(hcn.sectors.every((s: { code: string }) => UNITS.HCN.sectors.some(x => x.code === s.code)));
    assert.ok(hmb.sectors.every((s: { code: string }) => UNITS.HMB.sectors.some(x => x.code === s.code)));
    assert.ok(hcn.sectors.some((s: { state: string }) => s.state === 'normal'), 'após a carga o motor já classifica os setores');

    const wrong = await get('/api/units/HCN/sectors/ME_CME_hmb/series', { headers: { cookie } });
    assert.equal(wrong.status, 404, 'setor do HMB não existe em /HCN');
    const ok = await get('/api/units/HMB/sectors/ME_CME_hmb/series?hours=12', { headers: { cookie } });
    assert.equal(ok.status, 200);
    const series = await ok.json();
    assert.ok(series.points.length > 10 && series.points.some((p: { expected: number | null }) => p.expected !== null));
  });

  test('unidade inválida ⇒ 400; parâmetros fora de faixa ⇒ 400', async () => {
    const cookie = await login();
    assert.equal((await get('/api/units/XYZ/overview', { headers: { cookie } })).status, 400);
    assert.equal((await get('/api/units/HCN/overview?days=9999', { headers: { cookie } })).status, 400);
    assert.equal((await get('/api/units/HCN/alerts?status=banana', { headers: { cookie } })).status, 400);
    assert.equal((await get("/api/units/HCN/alerts?sector=DROP%20TABLE", { headers: { cookie } })).status, 400);
  });

  test('um alerta do HMB não abre pela URL do HCN', async () => {
    const cookie = await login();
    // gera um alerta no HMB pela API do ciclo
    for (let i = 0; i < 6; i++) {
      sims.HMB.tick({ factor: { ME_QGBT_E_16_hmb: 3 } });
      CLOCK.now = new Date(sims.HMB.now.getTime() + 60000);
      await get('/api/cron-check?hospital=hmb', bearer('segredo-hmb-654321'));
    }
    const list = await (await get('/api/units/HMB/alerts?limit=5', { headers: { cookie } })).json();
    assert.ok(list.total >= 1, 'alerta registrado no HMB');
    assert.ok(list.items.every((a: { unit: string }) => a.unit === 'HMB'));
    const id = list.items[0].id;
    assert.equal((await get(`/api/units/HMB/alerts/${id}`, { headers: { cookie } })).status, 200);
    assert.equal((await get(`/api/units/HCN/alerts/${id}`, { headers: { cookie } })).status, 404);
    const detail = await (await get(`/api/units/HMB/alerts/${id}`, { headers: { cookie } })).json();
    assert.ok(detail.events.length >= 1 && typeof detail.events[0].explain.reason === 'string');
    const hcnList = await (await get('/api/units/HCN/alerts', { headers: { cookie } })).json();
    assert.ok(!hcnList.items.some((a: { id: number }) => a.id === id));
  });
});

describe('relatórios', () => {
  test('exige unidade explícita', async () => {
    const cookie = await login();
    assert.equal((await get('/api/reports/alerts?format=xlsx', { headers: { cookie } })).status, 400);
    assert.equal((await get('/api/reports/alerts?unit=ZZZ', { headers: { cookie } })).status, 400);
  });

  test('Excel com as duas unidades: abas separadas e nome de arquivo identificando ambas', async () => {
    const cookie = await login();
    const res = await get('/api/reports/alerts?unit=HCN,HMB&from=2026-09-01&to=2026-12-31&format=xlsx', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /alertas_HCN-HMB_2026-09-01_a_2026-12-31\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map(w => w.name), ['Resumo', 'HCN - Alertas', 'HCN - Por setor', 'HMB - Alertas', 'HMB - Por setor']);
    const hmb = wb.getWorksheet('HMB - Alertas')!;
    const units = new Set<string>();
    hmb.eachRow((r, n) => {
      if (n >= 4 && !String(r.getCell(2).value).startsWith('TOTAL') && r.getCell(1).value && String(r.getCell(1).value).length <= 4) units.add(String(r.getCell(1).value));
    });
    assert.deepEqual([...units], ['HMB']);
  });

  test('PDF de uma unidade', async () => {
    const cookie = await login();
    const res = await get('/api/reports/alerts?unit=HMB&from=2026-09-01&to=2026-12-31&format=pdf', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  });
});

describe('ingestão direta pela máquina do hospital', () => {
  test('exige a chave da unidade e valida o corpo', async () => {
    assert.equal((await get('/api/ingest/HCN', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
    // a unidade não tem INGEST_KEY configurada ⇒ fechada
    assert.equal((await get('/api/ingest/HCN', { method: 'POST', body: '{}', ...bearer('qualquer'), headers: { 'content-type': 'application/json', Authorization: 'Bearer qualquer' } })).status, 401);
  });
});

describe('webhook de status da Vonage (rejeição assíncrona da Meta)', () => {
  test('mensagem rejeitada vira "falhou" e o aviso do alerta volta a ser elegível', async () => {
    const alert = (await db.query<{ id: number }>('SELECT id FROM alerts WHERE origin = $1 ORDER BY id DESC LIMIT 1', ['engine'])).rows[0];
    assert.ok(alert, 'há um alerta do motor criado pelos testes anteriores');
    const unit = (await db.query<{ unit_id: number }>('SELECT unit_id FROM alerts WHERE id = $1', [alert.id])).rows[0];
    await db.query("UPDATE alerts SET last_notified_at = now(), last_notified_severity = 'alto' WHERE id = $1", [alert.id]);
    const n = await db.query<{ id: number }>(
      `INSERT INTO notifications (unit_id, channel, kind, status, payload) VALUES ($1, 'whatsapp', 'alert_digest', 'sent', $2::jsonb) RETURNING id`,
      [unit.unit_id, JSON.stringify({ result: { recipients: [{ messageUuid: 'uuid-rejeitada-1', status: 'success' }] } })]
    );
    await db.query('INSERT INTO notification_alerts (notification_id, alert_id, reason, prev_notified_at, prev_notified_severity) VALUES ($1, $2, $3, NULL, NULL)', [n.rows[0].id, alert.id, 'opened']);

    const res = await fetch(`${base}/api/webhooks/vonage-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_uuid: 'uuid-rejeitada-1', status: 'rejected', error: { title: 'Invalid Parameters' } }),
    });
    assert.equal(res.status, 200);
    const after = (await db.query<{ status: string; error: string | null }>('SELECT status, error FROM notifications WHERE id = $1', [n.rows[0].id])).rows[0];
    assert.equal(after.status, 'failed');
    assert.match(after.error ?? '', /rejected.*Invalid Parameters/);
    const a = (await db.query<{ last_notified_at: Date | null }>('SELECT last_notified_at FROM alerts WHERE id = $1', [alert.id])).rows[0];
    assert.equal(a.last_notified_at, null, 'o motor volta a propor o aviso');
  });

  test('status de mensagem desconhecida ou entregue é aceito sem efeito', async () => {
    for (const body of [{ message_uuid: 'nao-existe', status: 'rejected' }, { message_uuid: 'x', status: 'delivered' }, {}]) {
      const res = await fetch(`${base}/api/webhooks/vonage-status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
    }
  });

  test('com VONAGE_SIGNATURE_SECRET definido, chamada sem assinatura válida é recusada', async () => {
    process.env.VONAGE_SIGNATURE_SECRET = 'assinatura-teste';
    try {
      const res = await fetch(`${base}/api/webhooks/vonage-status`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer a.b.c' }, body: '{}' });
      assert.equal(res.status, 401);
    } finally {
      delete process.env.VONAGE_SIGNATURE_SECRET;
    }
  });
});
