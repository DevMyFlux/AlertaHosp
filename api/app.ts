import express from "express";
import { GoogleGenAI } from "@google/genai";
import Papa from "papaparse";
import { sendAlertNotification } from "./lib/notify.js";
import { getActiveSectors, setActiveSectors, getRecentAlerts, recordAlert } from "./lib/serverAlertStore.js";
import { resolveHospitalRuntime } from "./lib/hospitalRuntime.js";
import { processCumulativeData } from "../src/data/processor.js";
import {
  buildSectorBandStats,
  detectSectorAnomalies,
  formatSectorParam,
  formatValorParam,
  formatDataHoraParam,
  formatSetorNomeParam,
  formatPercentualParam,
  formatExcedenteKwhParam,
  formatCustoEventoParam,
  formatImpactoMensalValorParam,
  formatOcorrenciasParam,
  formatCausaProvavelParam,
  formatAcaoRecomendadaParam,
  formatStandardAlertMessage,
  withHospitalPrefix,
} from "../src/lib/anomalyDetection.js";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const app = express();

app.use(express.json());

// API route for WhatsApp / SMS Notifications (disparo manual/pelo frontend)
app.post("/api/notify", async (req, res) => {
  const { message, sector, valor, phone, appId, privateKey, whatsappFrom, templateOverride, templateParams, hospital } = req.body;
  // Sem quebrar o disparo manual do HCN: quando o frontend manda `phone`
  // (tela de Configurações sempre manda), ele prevalece; só cai nos
  // destinatários/remetente do hospital quando não vier nada no corpo.
  const runtime = resolveHospitalRuntime(hospital);
  const result = await sendAlertNotification({
    message, sector, valor,
    phone: phone || runtime.alertPhones,
    appId, privateKey,
    whatsappFrom: whatsappFrom || runtime.alertWhatsappFrom,
    templateOverride, templateParams,
  });
  if (result.ok === true) {
    res.json({ success: true, results: result.results });
  } else {
    res.status(result.status).json({ error: result.error, results: result.results });
  }
});

// Ciclo completo (buscar planilha -> detectar anomalia -> notificar) rodando
// no servidor, disparado por um agendador externo (Vercel Cron ou um pinger
// como cron-job.org) em vez de depender de alguém ter o app aberto num
// navegador (era exatamente essa a causa dos alertas só funcionarem na
// máquina de quem deixava a aba aberta — ver App.tsx, que mantém o polling
// só como conveniência de visualização "ao vivo", não mais como único
// disparador). Protegido por CRON_SECRET pra não virar endpoint público de
// disparo de SMS/WhatsApp.
app.all("/api/cron-check", async (req, res) => {
  // ?hospital=hcn (default) | hmb | ... — cada hospital tem a sua planilha
  // de telemetria, o seu Apps Script e o seu segredo. Sem o parâmetro, o
  // comportamento é idêntico ao anterior (HCN).
  const runtime = resolveHospitalRuntime(
    typeof req.query.hospital === 'string' ? req.query.hospital : undefined
  );

  const expectedSecret = runtime.cronSecret;
  const authHeader = req.headers['authorization'];
  const providedSecret = (typeof authHeader === 'string' && authHeader.replace(/^Bearer\s+/i, ''))
    || (typeof req.query.secret === 'string' ? req.query.secret : undefined);

  if (!expectedSecret || providedSecret !== expectedSecret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!runtime.bridge) {
    res.status(500).json({
      error: `SHEETS_WEBAPP_URL/CRON_SECRET${runtime.id === 'atual' ? '' : '_' + runtime.id.toUpperCase()} não configurados — necessário para o cron não reenviar o mesmo alerta a cada execução. Ver apps-script/README.md.`
    });
    return;
  }

  if (!runtime.sheetUrl) {
    res.json({ ok: true, hospital: runtime.id, anomalies: 0, notified: [], message: 'Hospital sem planilha de telemetria configurada' });
    return;
  }

  try {
    const csvResponse = await fetch(runtime.sheetUrl);
    if (!csvResponse.ok) throw new Error(`Falha ao buscar planilha de telemetria (HTTP ${csvResponse.status})`);
    const csvText = await csvResponse.text();

    const parsedCsv = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const raw = parsedCsv.data as any[];
    if (!raw || raw.length === 0) throw new Error('Planilha sem dados');

    const processed = processCumulativeData(raw, runtime.allSectors);
    if (processed.length === 0) {
      res.json({ ok: true, hospital: runtime.id, anomalies: 0, notified: [], message: 'Sem dados processados' });
      return;
    }

    const last = processed[processed.length - 1];
    const sStats = buildSectorBandStats(processed, runtime.allSectors);

    const [recentAlerts, activeSectors] = await Promise.all([
      getRecentAlerts(30 * 24, runtime.bridge),
      getActiveSectors(runtime.bridge),
    ]);

    const anomalies = detectSectorAnomalies(last, sStats, processed, recentAlerts, runtime.sectorMapping, runtime.allSectors);
    const currentSectorKeys = new Set(anomalies.map(a => a.sectorKey));

    // Setores que normalizaram (não aparecem mais como anomalia) saem do
    // conjunto ativo e liberam pra alertar de novo na próxima vez.
    const stillActive = Array.from(activeSectors).filter(key => currentSectorKeys.has(key));

    const notified: string[] = [];
    const failed: { sectorKey: string; error: string }[] = [];

    const phone = runtime.alertPhones || undefined;
    const whatsappFrom = runtime.alertWhatsappFrom || undefined;

    for (const anomaly of anomalies) {
      // Já alertado e a anomalia ainda persiste — evita reenviar a cada
      // execução do cron (equivalente ao alertedSectorsRef do App.tsx, só
      // que persistido no Redis pra sobreviver entre execuções serverless).
      if (activeSectors.has(anomaly.sectorKey)) continue;

      // Nome do setor prefixado com o hospital só no texto do alerta (o
      // WhatsApp é compartilhado — chega como "Alerta HCN" pros dois).
      const forAlert = withHospitalPrefix(anomaly, runtime.label, runtime.id === 'atual');
      const message = formatStandardAlertMessage(forAlert);
      const sectorParam = formatSectorParam(forAlert.sectorName, forAlert.severity);
      const valor = formatValorParam(forAlert.val, forAlert.expectedMax);
      const templateParams = forAlert.templateOverride
        ? [
            formatDataHoraParam(forAlert),
            formatSetorNomeParam(forAlert.sectorName),
            formatPercentualParam(anomaly),
            formatExcedenteKwhParam(anomaly),
            formatCustoEventoParam(anomaly),
            formatImpactoMensalValorParam(anomaly),
            formatOcorrenciasParam(anomaly),
            formatCausaProvavelParam(anomaly),
            formatAcaoRecomendadaParam(anomaly),
          ]
        : undefined;

      const result = await sendAlertNotification({
        sector: sectorParam, message, valor, phone, whatsappFrom,
        templateOverride: anomaly.templateOverride, templateParams,
      });

      if (result.ok === true) {
        stillActive.push(anomaly.sectorKey);
        notified.push(anomaly.sectorKey);
        await recordAlert(anomaly, runtime.bridge);
      } else {
        failed.push({ sectorKey: anomaly.sectorKey, error: result.error });
        console.warn(`Falha ao notificar automaticamente sobre ${anomaly.sectorName}:`, result.error);
      }
    }

    await setActiveSectors(stillActive, runtime.bridge);

    res.json({ ok: true, hospital: runtime.id, anomalies: anomalies.length, notified, failed });
  } catch (error: any) {
    console.warn("Cron check error:", error?.message || String(error));
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get("/api/alert-history", async (req, res) => {
  try {
    const runtime = resolveHospitalRuntime(
      typeof req.query.hospital === 'string' ? req.query.hospital : undefined
    );
    if (!runtime.bridge) {
      res.json({ rows: [] });
      return;
    }
    const { getRows } = await import("./lib/sheetsBridge.js");
    const rows = await getRows(runtime.bridge);
    res.json({ rows });
  } catch (error: any) {
    console.warn("Aviso: Falha ao carregar histórico remoto (Apps Script desconfigurado?). Retornando lista vazia.");
    res.json({ rows: [] });
  }
});

// A API de Mensagens da Vonage aceita o envio de forma síncrona (fila pra
// entrega) e só informa o resultado real (entregue/rejeitado pela Meta) de
// forma assíncrona, via webhook. Sem esses endpoints configurados na
// aplicação Vonage, não há como saber por que uma mensagem foi rejeitada.
app.post("/api/webhooks/vonage-status", (req, res) => {
  console.warn("[Vonage status webhook]", JSON.stringify(req.body));
  res.sendStatus(200);
});

app.post("/api/webhooks/vonage-inbound", (req, res) => {
  console.warn("[Vonage inbound webhook]", JSON.stringify(req.body));
  res.sendStatus(200);
});

// API route for Chat
app.post("/api/chat", async (req, res) => {
  try {
    const { message, telemetryData } = req.body;

    const systemInstruction = `Você é um Engenheiro de Dados especialista em Eficiência Energética e Manutenção Hospitalar.
Sua função primária e única é ANALISAR OS DADOS DE TELEMETRIA fornecidos e gerar diagnósticos precisos por setor.

Regras Estritas de Análise:
1. Você SEMPRE deve basear suas respostas nos dados de telemetria fornecidos (se disponíveis).
2. Identifique anomalias, picos de consumo ou justifique variações com base na operação de cada setor.
3. Se o usuário fizer uma pergunta genérica, responda conectando a pergunta aos dados fornecidos. Se os dados não estiverem disponíveis, solicite-os.
4. OBRIGATÓRIO: Sempre comunique os valores de consumo de energia utilizando a unidade kWh (kilowatt-hora), e não kW.

Diretrizes por Setor e Lógica de Manutenção:
- LAVANDERIA: Analise o consumo das máquinas e do ar condicionado. Picos devem ser cruzados com horários. O consumo "Outros" (Total - Máquinas - Ar) alto fora de hora indica luz ou ar esquecido ligado.
- UTI: Exige estabilidade 24/7. Quedas bruscas são alertas CRÍTICOS (falha de energia/nobreak). Variações lentas de subida no ar condicionado indicam falha iminente no compressor ou filtros sujos.
- CENTRO CIRÚRGICO: Alta variabilidade dependendo de procedimentos. Avalie a proporção do ar condicionado em relação aos equipamentos médicos.
- TOMOGRAFIA: Consumo extremamente alto durante exames (picos curtos). Avalie o consumo de stand-by (se estiver subindo ao longo dos dias, indica degradação).

Formato de Resposta (OBRIGATÓRIO para responder com diagnósticos):
Sempre que analisar os dados e encontrar padrões, responda EXATAMENTE neste formato para cada setor analisado:
**DIAGNÓSTICO DA IA - [NOME DO SETOR]**
- **Observação Técnica:** [Descreva o que os valores dos dados mostram de forma específica (ex: pico de X kWh às Y horas)]
- **Análise / Causa Provável:** [Sua interpretação técnica baseada nas diretrizes]
- **Plano de Ação:** [Instrução direta para a equipe de manutenção]`;

    const promptData = telemetryData && telemetryData !== "[]"
      ? `\n\n[DADOS DE TELEMETRIA (ÚLTIMOS REGISTROS)]:\n${telemetryData}`
      : `\n\n[AVISO AO MODELO: Nenhum dado de telemetria foi fornecido ou carregado nesta requisição. Avise o usuário.]`;

    const combinedMessage = message + promptData;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: combinedMessage,
      config: {
        systemInstruction,
      }
    });

    res.json({ text: response.text });
  } catch (error: any) {
    console.warn("AI generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default app;
