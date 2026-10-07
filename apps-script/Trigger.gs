// ─────────────────────────────────────────────────────────────────────────────
// Gatilho do ciclo de alertas (Apps Script).
//
// Agora todo o estado dos alertas fica no PostgreSQL; este script só tem UMA
// função: chamar /api/cron-check a cada 15 minutos. Ele pode ser colado em
// qualquer planilha (ex.: a de telemetria de cada hospital) e NÃO guarda segredo
// no código: a URL e o segredo ficam nas Propriedades do script.
//
// Instalação (uma vez por hospital):
//   1. Extensões > Apps Script > cole este arquivo (apague o código antigo).
//   2. Configurações do projeto > Propriedades do script > adicione:
//        CRON_CHECK_URL = https://<seu-dominio>/api/cron-check            (HCN)
//                         https://<seu-dominio>/api/cron-check?hospital=HMB (HMB)
//        CRON_SECRET    = o mesmo valor de CRON_SECRET (HCN) / CRON_SECRET_HMB (HMB) na Vercel
//   3. Gatilhos > Adicionar gatilho > função pingCronCheck > baseado em tempo >
//      a cada 15 minutos.
//
// O script antigo (Code.gs / Code_HMB.gs) com a aba EstadoAlertas deixa de ser
// usado: o histórico dele foi importado para o banco (scripts/load-history.ts).
// ─────────────────────────────────────────────────────────────────────────────

function pingCronCheck() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('CRON_CHECK_URL');
  var secret = props.getProperty('CRON_SECRET');
  if (!url || !secret) {
    throw new Error('Configure CRON_CHECK_URL e CRON_SECRET nas Propriedades do script.');
  }

  // Evita dois pings sobrepostos (o backend também protege com lock no banco).
  var cache = CacheService.getScriptCache();
  if (cache.get('pingCronCheck_running')) return;
  cache.put('pingCronCheck_running', '1', 120);
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + secret },
      muteHttpExceptions: true,
    });
    var status = resp.getResponseCode();
    // Sem este log a execução sempre aparece como "Concluído", mesmo com 401/500.
    Logger.log('pingCronCheck -> status=' + status + ' | ' + resp.getContentText().slice(0, 300));
    if (status >= 400) {
      throw new Error('cron-check respondeu HTTP ' + status + ' — veja o log da execução.');
    }
  } finally {
    cache.remove('pingCronCheck_running');
  }
}
