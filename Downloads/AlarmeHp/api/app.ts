import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Vonage } from '@vonage/server-sdk';
import { Auth } from '@vonage/auth';
import { WhatsAppTemplate, WhatsAppLanguageCode } from '@vonage/messages';

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

// O SDK da Vonage descarta o corpo da resposta HTTP em erros (só lança com
// o status code), mas o corpo ainda não foi lido nesse ponto — conseguimos
// ler nós mesmos pra saber o motivo real da rejeição (a Meta normalmente
// responde { title, detail } explicando o porquê).
async function extractVonageErrorDetail(error: any): Promise<string> {
  const fallback = error?.message || String(error);
  const response = error?.response;
  if (!response || typeof response.text !== 'function') {
    return fallback;
  }
  try {
    const bodyText = await response.text();
    if (!bodyText) return fallback;
    try {
      const body = JSON.parse(bodyText);
      return body?.detail || body?.title || bodyText;
    } catch {
      return bodyText;
    }
  } catch {
    return fallback;
  }
}

// API route for WhatsApp / SMS Notifications
app.post("/api/notify", async (req, res) => {
  try {
    const { message, sector, phone, appId, privateKey, whatsappFrom } = req.body;
    const to = phone || '5511949102183'; // Default se não for enviado
    const from = whatsappFrom || '556298792013'; // Sender for WhatsApp

    const apiKey = process.env.VONAGE_API_KEY;
    const apiSecret = process.env.VONAGE_API_SECRET;
    // As variáveis de ambiente do servidor têm prioridade: são a fonte
    // confiável e mantida atualizada. appId/privateKey salvos no navegador
    // (tela de Configurações) só são usados como fallback, quando o
    // servidor não tem credenciais configuradas — caso contrário um valor
    // antigo salvo ali (de testes passados) sobrescreveria silenciosamente
    // a configuração correta, causando falha na Application/template sem
    // erro aparente.
    const applicationId = process.env.VONAGE_APPLICATION_ID || appId;
    const rawPrivateKey = process.env.VONAGE_PRIVATE_KEY || privateKey;

    if (!apiKey || !apiSecret || !applicationId || !rawPrivateKey) {
      res.status(500).json({
        error: "Credenciais da Vonage não configuradas. Defina VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID e VONAGE_PRIVATE_KEY nas variáveis de ambiente."
      });
      return;
    }

    const pk = rawPrivateKey.replace(/\\n/g, '\n');

    // Mensagens de WhatsApp iniciadas pela empresa (fora de uma janela de
    // conversa ativa de 24h) só são entregues pela Meta se usarem um Message
    // Template pré-aprovado, referenciado como "namespace:nome_do_template"
    // (a WABA vinculada ao número já tem o template "sistema_de_alerta"
    // aprovado e em uso pelo sistema legado em Java).
    const templateNamespace = process.env.VONAGE_WHATSAPP_TEMPLATE_NAMESPACE || '678e6487_99c4_4e6d_995c_3dab76a2438b';
    const templateNameOnly = process.env.VONAGE_WHATSAPP_TEMPLATE_NAME || 'sistema_de_alerta';
    const templateName = `${templateNamespace}:${templateNameOnly}`;
    const templateLocale = (process.env.VONAGE_WHATSAPP_TEMPLATE_LOCALE || WhatsAppLanguageCode.PORTUGUESE_BR) as WhatsAppLanguageCode;
    const horaFormatada = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    // Parâmetros de template do WhatsApp não podem conter quebras de linha
    // nem espaços múltiplos, ou a Meta rejeita a mensagem. Também truncamos
    // no limite documentado da Meta (1024 caracteres) como proteção extra.
    const toTemplateParam = (value: string) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1024);

    try {
      const dynamicVonage = new Vonage(new Auth({ apiKey, apiSecret, applicationId, privateKey: pk }));

      // We will try to send to multiple numbers if 'phone' is a comma separated string
      const phones = phone ? phone.split(',').map((p: string) => p.trim()) : [to];

      const results = [];
      let hasSuccess = false;

      for (const targetPhone of phones) {
        try {
          await dynamicVonage.messages.send(new WhatsAppTemplate({
            to: targetPhone,
            from: from,
            whatsapp: {
              policy: 'deterministic',
              locale: templateLocale,
            },
            template: {
              name: templateName,
              parameters: [horaFormatada, toTemplateParam(sector), toTemplateParam(message)],
            },
          }));
          results.push({ phone: targetPhone, status: 'success', channel: 'whatsapp' });
          hasSuccess = true;
        } catch (wppError: any) {
          const whatsappErrorDetail = await extractVonageErrorDetail(wppError);
          console.warn(`WhatsApp failed for ${targetPhone}, falling back to SMS:`, whatsappErrorDetail);

          try {
            const smsResponse = await dynamicVonage.sms.send({
              to: targetPhone,
              from: from,
              text: `ALERTA - ${sector}: ${message}`.substring(0, 160)
            });

            if (smsResponse.messages && smsResponse.messages[0].status !== '0') {
              throw new Error(smsResponse.messages[0]['error-text'] || smsResponse.messages[0].status);
            }
            results.push({ phone: targetPhone, status: 'success', channel: 'sms', whatsappError: whatsappErrorDetail });
            hasSuccess = true;
          } catch (smsError: any) {
            results.push({
              phone: targetPhone,
              status: 'error',
              error: smsError?.message || String(smsError),
              whatsappError: whatsappErrorDetail
            });
          }
        }
      }

      if (hasSuccess) {
        res.json({ success: true, results });
      } else {
        res.status(401).json({
          error: `Falha de Autenticação nas APIs da Vonage. Verifique suas credenciais.`,
          results
        });
      }
    } catch (error: any) {
      console.warn("Notification Error:", error?.message || String(error));
      res.status(500).json({ error: error?.message || String(error) });
    }
  } catch (error: any) {
    const errorMsg = error?.message || String(error) || "Unknown error";
    console.warn("Notification Error:", errorMsg);
    res.status(500).json({ error: errorMsg });
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

// API route for Auto Anomaly Detection
app.post("/api/check-anomalies", async (req, res) => {
  try {
    const { telemetryData } = req.body;

    const systemInstruction = `Você é um Engenheiro de Dados especialista em Eficiência Energética.
Analise os dados de telemetria mais recentes fornecidos.
Se houver alguma anomalia clara (ex: pico excessivo de consumo, consumo alto fora do padrão ou em horários atípicos), retorne um JSON EXATAMENTE neste formato:
{ "hasAnomaly": true, "sector": "Nome do Setor", "message": "Descrição da anomalia identificada com valores em kWh. Recomende uma ação." }

Se os dados estiverem normais e dentro do padrão, retorne:
{ "hasAnomaly": false }

Regras:
1. Responda APENAS com o JSON. Nenhuma outra palavra.
2. Use sempre kWh (kilowatt-hora) nas descrições de energia.`;

    const promptData = `[DADOS DE TELEMETRIA]:\n${telemetryData}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: promptData,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
      }
    });

    const resultText = response.text || "{}";
    const resultJson = JSON.parse(resultText);

    res.json(resultJson);
  } catch (error: any) {
    console.warn("Anomaly detection error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default app;
