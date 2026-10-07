import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../backend/infra/logger.js';
import { loadAppEnv, maskPhone } from '../backend/infra/env.js';
import { gvizUrl, SheetTelemetrySource, type FetchLike } from '../backend/infra/sheetSource.js';
import { createSessionToken, safeEqual, verifySessionToken } from '../backend/http/security.js';
import { redactConnectionString } from '../backend/infra/db.js';
import { buildSmsText, buildWhatsAppParams, monthlyProjectionBrl, type DigestItem } from '../core/alerts/messages.js';
import { describeEvaluation } from '../core/alerts/explain.js';
import { resolveUnitCode, UNITS } from '../core/units.js';
import { evaluation } from './helpers.js';

describe('logs estruturados nunca carregam segredos', () => {
  test('redige senhas, tokens, chaves, cookies e connection strings', () => {
    const out = redact({
      password: 'abc', apiSecret: 'x', token: 't', Authorization: 'Bearer zzz', private_key: '-----BEGIN', cookie: 'c=1',
      note: 'conectando em postgres://user:SENHA@host:5432/db agora',
      nested: { client_secret: 'q', ok: 1 },
    }) as Record<string, any>;
    for (const k of ['password', 'apiSecret', 'token', 'Authorization', 'private_key', 'cookie']) assert.equal(out[k], '[redacted]', k);
    assert.equal(out.nested.client_secret, '[redacted]');
    assert.equal(out.nested.ok, 1);
    assert.ok(!out.note.includes('SENHA'));
    assert.match(out.note, /postgres:\/\/user:\*\*\*@host/);
  });

  test('telefones aparecem mascarados e a linha é JSON válido', () => {
    const lines: string[] = [];
    createLogger({ log: l => lines.push(l) }).info('notification.sent', { unit: 'HCN', recipient: '5511900000001', phone: '5511900000002' });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'notification.sent');
    assert.equal(parsed.recipient, '*********0001');
    assert.ok(!lines[0].includes('5511900000001'));
  });

  test('connection string é exibida sem a senha', () => {
    assert.equal(redactConnectionString('postgres://app:segredo@db.exemplo.com:5432/energia'), 'postgres://app:***@db.exemplo.com:5432/energia');
  });
});

describe('configuração por ambiente', () => {
  test('telefones aceitam vírgula, espaço ou ponto-e-vírgula (o HMB já foi salvo com espaço por engano)', () => {
    const env = loadAppEnv({ ALERT_PHONE_NUMBERS_HMB: '5511900000001 5511900000002;+5511900000003', ALERT_PHONE_NUMBERS: '5511911112222' } as NodeJS.ProcessEnv);
    assert.deepEqual(env.units.HMB.phones, ['5511900000001', '5511900000002', '5511900000003']);
    assert.deepEqual(env.units.HCN.phones, ['5511911112222']);
  });

  test('cada hospital lê as próprias variáveis (HCN sem sufixo, HMB com _HMB) e nunca as do outro', () => {
    const env = loadAppEnv({ CRON_SECRET: 'a', CRON_SECRET_HMB: 'b' } as NodeJS.ProcessEnv);
    assert.equal(env.units.HCN.cronSecret, 'a');
    assert.equal(env.units.HMB.cronSecret, 'b');
    assert.equal(loadAppEnv({ CRON_SECRET: 'a' } as NodeJS.ProcessEnv).units.HMB.cronSecret, null);
  });

  test('sem destinatário configurado NÃO há número padrão embutido', () => {
    const env = loadAppEnv({} as NodeJS.ProcessEnv);
    assert.deepEqual(env.units.HCN.phones, []);
    assert.deepEqual(env.units.HMB.phones, []);
  });

  test('máscara de telefone', () => {
    assert.equal(maskPhone('5511900000001'), '*********0001');
  });
});

describe('fonte de telemetria (planilha)', () => {
  test('gviz pede só as N linhas mais recentes da aba certa', () => {
    const url = gvizUrl(UNITS.HMB.sheetCsvUrl!, 300);
    assert.match(url, /\/gviz\/tq\?tqx=out:csv&gid=370261008&tq=select%20\*%20limit%20300$/);
  });

  test('usa gviz e cai para o CSV completo se o gviz falhar ou devolver lixo', async () => {
    const calls: string[] = [];
    const csv = 'E3TimeStamp,ME_CME_hmb\n2026-10-07 10:00:00,"1,5"\n';
    const fetchFn: FetchLike = async url => {
      calls.push(url);
      if (url.includes('/gviz/')) return { ok: true, status: 200, text: async () => '<html>erro</html>' };
      return { ok: true, status: 200, text: async () => csv };
    };
    const rows = await new SheetTelemetrySource(fetchFn).fetchRows(UNITS.HMB, 300);
    assert.equal(calls.length, 2);
    assert.equal(rows[0].ME_CME_hmb, '1,5');
  });

  test('erro HTTP em ambos propaga como falha (o ciclo registra ingest.error)', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, text: async () => '' });
    await assert.rejects(() => new SheetTelemetrySource(fetchFn).fetchRows(UNITS.HCN, 'all'), /HTTP 500/);
  });
});

describe('sessão e comparação de segredos', () => {
  test('token válido, adulterado e expirado', () => {
    const t = createSessionToken('s3cret', 1_000);
    assert.equal(verifySessionToken(t, 's3cret', 2_000), true);
    assert.equal(verifySessionToken(t, 'outro', 2_000), false);
    assert.equal(verifySessionToken(t.slice(0, -2) + 'xx', 's3cret', 2_000), false);
    assert.equal(verifySessionToken(t, 's3cret', 1_000 + 13 * 3600 * 1000), false);
    assert.equal(verifySessionToken(undefined, 's3cret'), false);
  });

  test('safeEqual compara em tempo constante e rejeita diferentes', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

describe('unidades', () => {
  test('apelidos legados resolvem para HCN; desconhecido é null (nunca HCN por engano)', () => {
    assert.equal(resolveUnitCode('atual'), 'HCN');
    assert.equal(resolveUnitCode(''), 'HCN');
    assert.equal(resolveUnitCode(undefined), 'HCN');
    assert.equal(resolveUnitCode('hmb'), 'HMB');
    assert.equal(resolveUnitCode('bogus'), null);
  });

  test('os dois hospitais têm identidade distinta e intervalos de amostragem corretos', () => {
    assert.equal(UNITS.HCN.expectedIntervalMin, 15);
    assert.equal(UNITS.HMB.expectedIntervalMin, 10);
    assert.notEqual(UNITS.HCN.accent, UNITS.HMB.accent);
    const hcn = new Set(UNITS.HCN.sectors.map(s => s.code));
    assert.ok(UNITS.HMB.sectors.every(s => !hcn.has(s.code)), 'nenhum código de setor é compartilhado entre as unidades');
  });
});

describe('mensagens e explicações', () => {
  const item = (over: Partial<DigestItem> = {}): DigestItem => ({
    sectorCode: 'ME_CME_hmb', sectorName: 'CME', kind: 'critico', reason: 'opened', severity: 'alto',
    openedAt: new Date('2026-10-04T10:48:00Z'), evaluatedAt: new Date('2026-10-04T10:58:00Z'), pctOver: 0.64,
    totalExcessKwh: 12.5, totalCostBrl: 9.38, lastExcessKwh: 6, windowHours: 2, occurrences30d: 3, hvacElevated: false, ...over,
  });
  const ctx = { unitCode: 'HMB', timezone: 'America/Sao_Paulo', intervalMin: 10, tariffBrlPerKwh: 0.75 };

  test('as 9 variáveis do template, sem quebra de linha, com a unidade no setor', () => {
    const p = buildWhatsAppParams([item()], ctx);
    assert.equal(p.length, 9);
    assert.match(p[0], /^domingo, 04\/10 às 07:58$/);
    assert.equal(p[1], 'HMB - CME');
    assert.equal(p[2], '64%');
    assert.match(p[3], /12,5 kWh/);
    assert.ok(p.every(x => !/[\n\r]/.test(x) && x.length <= 1024));
  });

  test('resumo com vários setores mantém um só texto e lista os demais', () => {
    const p = buildWhatsAppParams([item(), item({ sectorCode: 'ME_COZINHA_hmb', sectorName: 'Cozinha', pctOver: 0.31 }), item({ sectorCode: 'ME_CAG01_hmb', sectorName: 'Água Gelada 1', pctOver: 0.5 })], ctx);
    assert.equal(p[1], 'HMB - CME (+2 setores)');
    assert.match(p[7], /Também acima do esperado: Cozinha \(\+31%\), Água Gelada 1 \(\+50%\)/);
  });

  test('lembrete e escalonamento ficam explícitos na mensagem', () => {
    const rem = buildWhatsAppParams([item({ reason: 'reminder', openedAt: new Date('2026-10-04T05:00:00Z') })], ctx);
    assert.match(rem[7], /^Alerta ainda ativo há 6 h\./);
    const esc = buildWhatsAppParams([item({ reason: 'escalated', severity: 'critico' })], ctx);
    assert.match(esc[7], /^Severidade elevada para CRÍTICO\./);
  });

  test('a projeção mensal respeita o intervalo da unidade (HMB = 10 min, não 15)', () => {
    const i = item({ lastExcessKwh: 1, windowHours: 4 });
    assert.equal(monthlyProjectionBrl(i, { ...ctx, intervalMin: 10 }), 1 * 6 * 4 * 30 * 0.75);
    assert.equal(monthlyProjectionBrl(i, { ...ctx, intervalMin: 15 }), 1 * 4 * 4 * 30 * 0.75);
  });

  test('SMS de contingência traz unidade, severidade e custo', () => {
    const sms = buildSmsText([item()], ctx);
    assert.match(sms, /ALERTA HMB - CME \(Alto\)/);
    assert.match(sms, /Equipe Carbono Zero/);
  });

  test('a explicação responde "por que disparou": valor, esperado, faixa, limite e o que definiu o limite', () => {
    const ev = evaluation('alto', { value: 20, expected: 10, sigma: 2, z: 5, pctOver: 1 });
    ev.binding.alto = 'envelope';
    const text = describeEvaluation(ev);
    assert.match(text, /20,0 kWh/);
    assert.match(text, /100% acima do esperado \(10,0 kWh\)/);
    assert.match(text, /faixa “Tarde”/);
    assert.match(text, /Limite de ALTO: 15,0 kWh, definido por maior valor já visto nesta faixa/);
    assert.match(text, /5,0σ/);
  });
});
