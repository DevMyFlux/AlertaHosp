// Cole este arquivo inteiro no editor do Apps Script da planilha de
// telemetria (Extensões > Apps Script), substituindo o conteúdo padrão de
// Code.gs. Ver apps-script/README.md para o passo a passo completo de
// instalação, deploy e configuração do gatilho de 15 em 15 minutos.
//
// Duas responsabilidades:
//   1. Web App (doGet/doPost) que o backend na Vercel usa pra ler/escrever
//      a aba "EstadoAlertas" — substitui um banco separado (Redis) ou uma
//      Service Account do Google Cloud, já que este script roda como o
//      dono da própria planilha (zero configuração de OAuth/API externa).
//   2. Gatilho de tempo (função pingCronCheck, configurado manualmente nos
//      Gatilhos do projeto) que chama /api/cron-check a cada 15 min —
//      substitui um pinger externo tipo cron-job.org, já que o Apps Script
//      já tem gatilhos de tempo nativos e gratuitos.

// PREENCHA os dois valores abaixo antes de implantar:
var SHARED_SECRET = 'COLE_AQUI_O_MESMO_VALOR_DE_CRON_SECRET_DA_VERCEL';
var CRON_CHECK_URL = 'https://SEU-DOMINIO.vercel.app/api/cron-check';

var TAB_NAME = 'EstadoAlertas';
var HEADER = ['sectorKey', 'band', 'loggedAt', 'resolvedAt'];

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
  if (provided !== SHARED_SECRET) {
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

// GET .../exec?secret=...&action=list
// Retorna todas as linhas da aba EstadoAlertas em JSON.
function doGet(e) {
  try {
    checkSecret_(e);
    var sheet = getOrCreateTab_();
    var values = sheet.getDataRange().getValues(); // inclui o cabeçalho
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (!r[0]) continue;
      rows.push({
        sectorKey: String(r[0]),
        band: String(r[1]),
        loggedAt: toIso_(r[2]),
        resolvedAt: toIso_(r[3]),
      });
    }
    return jsonOutput_({ rows: rows });
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

// POST .../exec?secret=...
// Body JSON: { action: "append", sectorKey, band }
//   -> abre uma nova linha "ativa" (resolvedAt vazio) pro setor.
// Body JSON: { action: "resolve", sectorKeys: [...] }
//   -> marca resolvedAt = agora nas linhas ativas desses setores.
function doPost(e) {
  try {
    checkSecret_(e);
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');
    var sheet = getOrCreateTab_();

    if (body.action === 'append') {
      sheet.appendRow([body.sectorKey, body.band, new Date().toISOString(), '']);
    } else if (body.action === 'resolve') {
      var wanted = {};
      (body.sectorKeys || []).forEach(function (k) { wanted[k] = true; });
      var values = sheet.getDataRange().getValues();
      var nowIso = new Date().toISOString();
      for (var i = 1; i < values.length; i++) {
        var r = values[i];
        if (r[0] && wanted[r[0]] && !r[3]) {
          sheet.getRange(i + 1, 4).setValue(nowIso);
        }
      }
    } else {
      throw new Error('ação desconhecida: ' + body.action);
    }

    return jsonOutput_({ ok: true });
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

// Função chamada pelo gatilho de tempo (configure em Gatilhos > Adicionar
// gatilho > pingCronCheck > Baseado em tempo > A cada 15 minutos). Dispara
// a checagem de anomalia/alerta no backend, independente de qualquer
// navegador estar aberto.
function pingCronCheck() {
  UrlFetchApp.fetch(CRON_CHECK_URL, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + SHARED_SECRET },
    muteHttpExceptions: true,
  });
}
