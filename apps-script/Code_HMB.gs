// ─────────────────────────────────────────────────────────────────────────
// Apps Script da planilha de ESTADO DE ALERTAS do HMB
// (planilha 1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc).
//
// Cole este arquivo inteiro no editor do Apps Script DESSA planilha
// (Extensões > Apps Script), substituindo o Code.gs padrão. NÃO é o mesmo
// deploy do HCN — é um Web App próprio, com segredo próprio e gatilho
// próprio. Ver apps-script/README.md, secção "HMB".
//
// Diferenças em relação ao Code.gs do HCN:
//   1. O segredo NÃO fica no código. Vem de PropertiesService (Script
//      Properties) — assim não vai pro Git. Chaves: SHARED_SECRET e
//      CRON_CHECK_URL.
//   2. LockService no doPost e no pingCronCheck — impede que duas execuções
//      (ex: gatilho disparando de novo antes da anterior terminar) mexam na
//      planilha ou disparem o cron ao mesmo tempo.
//   3. pingCronCheck chama /api/cron-check?hospital=hmb.
//
// Responsabilidades (iguais às do HCN):
//   - Web App (doGet/doPost) que o backend usa pra ler/escrever a aba
//     "EstadoAlertas" desta planilha;
//   - gatilho de tempo (pingCronCheck) que chama o backend a cada 15 min.
// ─────────────────────────────────────────────────────────────────────────

var TAB_NAME = 'EstadoAlertas';

// excedenteKwh/custoGeradoBRL ficam nas colunas E/F (depois de resolvedAt)
// de propósito — o "resolve" grava na coluna D por índice fixo
// (getRange(i+1, 4)), então nada pode entrar entre band e resolvedAt.
//
// consumoMedido/consumoReferencia/percentualExcedente (G/H/I, 2026-09-15):
// motor v2 — cada alerta passa a gravar o consumo real medido, a referência
// usada na comparação, e o percentual acima dela, além do excedente em
// kWh/custo que já existiam. Ver api/lib/serverAlertStore.ts.
var HEADER = ['sectorKey', 'band', 'loggedAt', 'resolvedAt', 'excedenteKwh', 'custoGeradoBRL', 'consumoMedido', 'consumoReferencia', 'percentualExcedente'];

// ── Config via Script Properties (Projeto > Configurações do projeto >
//    Propriedades do script). Rode setup() uma vez OU preencha na UI. ──
function _props_() {
  return PropertiesService.getScriptProperties();
}

function _sharedSecret_() {
  var s = _props_().getProperty('SHARED_SECRET');
  if (!s) throw new Error('SHARED_SECRET nao configurado nas Propriedades do script');
  return s;
}

function _cronCheckUrl_() {
  var u = _props_().getProperty('CRON_CHECK_URL');
  if (!u) throw new Error('CRON_CHECK_URL nao configurado nas Propriedades do script');
  return u;
}

/**
 * Rode UMA VEZ pelo editor (selecione setup no dropdown de funções e clique
 * em Executar) pra gravar as propriedades. Depois pode apagar os valores
 * daqui — eles já ficam salvos no projeto. NÃO commite valores reais.
 */
function setup() {
  _props_().setProperties({
    // Gere um NOVO segredo, diferente do HCN: openssl rand -hex 32
    SHARED_SECRET: 'COLE_UM_SEGREDO_NOVO_AQUI_SO_PARA_RODAR_ESTA_FUNCAO',
    // URL de produção do backend + rota + hospital. Confirme o domínio real.
    CRON_CHECK_URL: 'https://SEU-DOMINIO.vercel.app/api/cron-check?hospital=hmb'
  }, false);
}

// ─────────────────────────────────────────────────────────────────────────

function getOrCreateTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
    sheet.appendRow(HEADER);
  }
  return sheet;
}

function checkSecret_(e) {
  var provided = (e.parameter && e.parameter.secret) || '';
  if (provided !== _sharedSecret_()) {
    throw new Error('unauthorized');
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function toIso_(value) {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : '';
}

// GET .../exec?secret=...&action=list  -> todas as linhas da aba em JSON.
function doGet(e) {
  try {
    checkSecret_(e);
    var sheet = getOrCreateTab_();
    var values = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (!r[0]) continue;
      rows.push({
        sectorKey: String(r[0]),
        band: String(r[1]),
        loggedAt: toIso_(r[2]),
        resolvedAt: toIso_(r[3]),
        excedenteKwh: Number(r[4]) || 0,
        custoGeradoBRL: Number(r[5]) || 0,
        consumoMedido: Number(r[6]) || 0,
        consumoReferencia: Number(r[7]) || 0,
        percentualExcedente: Number(r[8]) || 0,
      });
    }
    return jsonOutput_({ rows: rows });
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

// POST .../exec?secret=...
//   { action: "append", sectorKey, band, excedenteKwh, custoGeradoBRL,
//     consumoMedido, consumoReferencia, percentualExcedente, selfClose }
//   { action: "resolve", sectorKeys: [...] }
//
// selfClose=true (motor v2, hoje sempre true nas chamadas do HMB): a linha
// já nasce com resolvedAt preenchido — é um registro de UMA ocorrência
// pontual (um ciclo de 15 min que ultrapassou o limite), não mais um
// "incidente em aberto" esperando o setor voltar ao normal. Isso é o que
// permite o backend gravar um alerta novo A CADA ciclo em que o setor
// continuar acima do limite, em vez de só no primeiro (ver runtime do
// hospital/alertEngineV2 em api/app.ts). Se por acaso existir uma linha
// antiga ainda aberta desse setor (de antes dessa mudança, ou de uma falha),
// ela é resolvida automaticamente aqui — não bloqueia o registro novo.
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Espera até 20s por outra execução; se não conseguir, falha explícito
    // (o backend trata como erro e tenta de novo no próximo ciclo) em vez
    // de escrever concorrente e duplicar/corromper linha.
    lock.waitLock(20000);
  } catch (lockErr) {
    return jsonOutput_({ error: 'busy: ' + String(lockErr) });
  }
  try {
    checkSecret_(e);
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    var sheet = getOrCreateTab_();

    if (body.action === 'append') {
      var nowIsoAppend = new Date().toISOString();

      if (body.selfClose) {
        // Motor v2: resolve qualquer linha antiga ainda aberta desse setor
        // (transição/legado) sem bloquear o registro novo, e grava a nova
        // linha já como ocorrência fechada (uma por ciclo).
        var valuesV2 = sheet.getDataRange().getValues();
        for (var k = 1; k < valuesV2.length; k++) {
          if (valuesV2[k][0] === body.sectorKey && !valuesV2[k][3]) {
            sheet.getRange(k + 1, 4).setValue(nowIsoAppend);
          }
        }
        sheet.appendRow([
          body.sectorKey,
          body.band,
          nowIsoAppend,
          nowIsoAppend, // resolvedAt = loggedAt: ocorrência pontual, já fechada
          Number(body.excedenteKwh) || 0,
          Number(body.custoGeradoBRL) || 0,
          Number(body.consumoMedido) || 0,
          Number(body.consumoReferencia) || 0,
          Number(body.percentualExcedente) || 0,
        ]);
      } else {
        // Motor clássico (HCN): dedup contra linha já ativa desse setor —
        // protege contra duas execuções do cron quase juntas enquanto o
        // setor segue "em incidente aberto" aguardando normalizar.
        var values = sheet.getDataRange().getValues();
        for (var j = 1; j < values.length; j++) {
          if (values[j][0] === body.sectorKey && !values[j][3]) {
            return jsonOutput_({ ok: true, deduped: true });
          }
        }
        sheet.appendRow([
          body.sectorKey,
          body.band,
          nowIsoAppend,
          '',
          Number(body.excedenteKwh) || 0,
          Number(body.custoGeradoBRL) || 0,
          Number(body.consumoMedido) || 0,
          Number(body.consumoReferencia) || 0,
          Number(body.percentualExcedente) || 0,
        ]);
      }
    } else if (body.action === 'resolve') {
      var wanted = {};
      (body.sectorKeys || []).forEach(function (k) { wanted[k] = true; });
      var rows = sheet.getDataRange().getValues();
      var nowIso = new Date().toISOString();
      for (var i = 1; i < rows.length; i++) {
        var r = rows[i];
        if (r[0] && wanted[r[0]] && !r[3]) {
          sheet.getRange(i + 1, 4).setValue(nowIso);
        }
      }
    } else {
      throw new Error('acao desconhecida: ' + body.action);
    }

    return jsonOutput_({ ok: true });
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Gatilho de tempo (Gatilhos > Adicionar > pingCronCheck > Baseado em tempo
// > A cada 15 minutos). Dispara o ciclo de alerta do HMB no backend.
function pingCronCheck() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // Já tem um ping em andamento (execução anterior travou > 15 min) —
    // não empilha outro.
    return;
  }
  try {
    UrlFetchApp.fetch(_cronCheckUrl_(), {
      method: 'get',
      headers: { Authorization: 'Bearer ' + _sharedSecret_() },
      muteHttpExceptions: true,
    });
  } finally {
    lock.releaseLock();
  }
}
