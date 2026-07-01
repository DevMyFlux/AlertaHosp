import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { Vonage } from '@vonage/server-sdk';
import { Auth } from '@vonage/auth';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const privateKeyBase64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC70S13YmER96LLmO6YciUT725TdQMfq8OYB6xY2Qflf6KOPemyO3HThdbthMqIsCAUz0whDjv5ux/iu7Q/F+KQ4u6w8nC+o0AwYKKx0XdPxMjd+nKqWm7BFDm5VntCLSS8n04JbA6ORbHLp4oEluyh8SVn+2WfNw5BG/eSR/fzW+jN0AabisWZPCHL14cHwNQ5nQ4kAbKFflw349qcbcWieIQdyCozMlqDFFp6ku4ZyEJg+F5iJpptkWPNMw9y9jjMm4yaGCOrIFkBh+BgD3dzQLgATeX/dPjJx0FeNpvardufQJC9pqgqG98ZCzX7oShCWmimmwIO31rgyJ2t+HptAgMBAAECggEABqQ7fNzEPPvqTFPQoCBtMjrFxnq9TQnoZUBkNlIaZuGwEGKdGHnkqQuzEXwgI1xDDilUcljMAyU8V+q2UYLZNrFnqmcwWHVyaCOKrUoQc4gsaDkag+6luvspnWWy/yCUi30Ap/GjxCEvy9lVVps1q/ZYkchAjDRIs0G3a/tSh875H9CL3kl9g5kWhTTQ6dy4p4wew6jDrmEy4oGBoeMvOfZudEtXfYodVbhKT1Y9qsl/AQqSDGVzb/1jRm0xuICMwgVZflRlZKUKg/JVxdw/VV7u8/PJRdkGfa27v+V6+SgPZ9Mgpk1V8QI/sLMQoEuIfrfeRUNh6/CYLyQ1Qa3ygQKBgQD0RjF7WSBApavYLD9lEo/BuYO6d/QvOh6cKIg3pMAq6j71IQwLpQPEKrOTEUH/tooazs5TEVpXKyg6iqLUzjaqA5vZa5eaY22Z3Lql2a8nbfuD20B23cGMVxKkeX7DVRljuv/z+4JgzVPyDRV4nmviMXLOF9Cv1rGOZF2n3hskLQKBgQDE1TOKHjMWpLyD6nOccUhu+/QtMyWckyIxUW1n77CTBrElFSt9n2caenE8GjfpIzYA2We6dbFiFdugsSQfuVHkxgEiZiICgnjmsPEMxXLngjsPe719FyyChK+0hLMcOJU8FpClcANxr/BxuDM7azgrQDLGkCd6HdTclnGnj41XQQKBgQDQNny6/S9Gq3Cc5KpsxrOOl0i3SsPy9YFd7haeB2pdqilb3H1d95wMO7GxbAZrpvZ0/05S8/mjT4AM1lsRNWzW4hiX7OPej12+xqy57aEk5NR8ggiiyUbPDvEvDPiGGyV3ItBE8V8ikCI7sfdZRwACX8/R5+7T0xapntdN3T4ZSQKBgA4w5N9fYAWQ6PqFy8IKtNMznR4pItwQC5YMrduhf1SKVfk7doA/Htrc2w8fQMqxPDKBeiYKWDifJM+IFfenj8zzrZ9CR89wgrD3Ltnh3m/shr+OB1JeeloKoPRd4N/3AGNtqQ4Ublsi+S3pvt/Y0hrkLQT93arDPdaNjjIremBBAoGAIgr8uEN0+CMZR4rn0HhPlko7frUKOcRvOxQt7yAy/l/u6NyW0zXo+Hgr7FBDqTh1YQPvoUu8jRE9GmLkGAxHeltFM2sCSFHuIu0zuLL3qzD9flRujf3fiTYJ3WVGVlJ0cl5LovkIfgFG81n12pvPb2PR2DlFGx5tnFy+ZX7VYNI=";
const defaultPrivateKey = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;


async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API route for WhatsApp / SMS Notifications
  app.post("/api/notify", async (req, res) => {
    try {
      const { message, sector, phone, appId, privateKey, whatsappFrom } = req.body;
      const to = phone || '5511943004579'; // Default se não for enviado
      const from = whatsappFrom || '556298792013'; // Sender for WhatsApp
      
      const apiKey = process.env.VONAGE_API_KEY || '38340e5d';
      const apiSecret = process.env.VONAGE_API_SECRET || 'ILKpz5neRhVusWnW';
      
      const applicationId = appId || process.env.VONAGE_APPLICATION_ID || 'ccbee98e-5b47-4142-a90f-ba6ca1e10276';
      const rawPrivateKey = privateKey || process.env.VONAGE_PRIVATE_KEY || defaultPrivateKey;
      const pk = rawPrivateKey.replace(/\\n/g, '\n');

      try {
        // Try WhatsApp first using Vonage SDK
        const authConfig: any = { apiKey, apiSecret };
        if (applicationId && pk) {
          authConfig.applicationId = applicationId;
          authConfig.privateKey = pk;
        }
        
        const dynamicVonage = new Vonage(new Auth(authConfig));

        // We will try to send to multiple numbers if 'phone' is a comma separated string
        const phones = phone ? phone.split(',').map((p: string) => p.trim()) : ['5511943004579', '551186510453'];
        
        const results = [];
        let hasSuccess = false;
        
        for (const targetPhone of phones) {
          try {
            await dynamicVonage.messages.send({
              to: targetPhone,
              from: from,
              channel: 'whatsapp',
              messageType: 'text',
              text: `🚨 ALERTA DE ANOMALIA - ${sector}\n\n${message}`
            } as any);
            results.push({ phone: targetPhone, status: 'success', channel: 'whatsapp' });
            hasSuccess = true;
          } catch (wppError: any) {
            console.warn(`WhatsApp failed for ${targetPhone}, falling back to SMS:`, wppError?.message || wppError);
            
            try {
              const smsResponse = await dynamicVonage.sms.send({
                to: targetPhone,
                from: from,
                text: `ALERTA - ${sector}: ${message}`.substring(0, 160)
              });
              
              if (smsResponse.messages && smsResponse.messages[0].status !== '0') {
                 throw new Error(smsResponse.messages[0]['error-text'] || smsResponse.messages[0].status);
              }
              results.push({ phone: targetPhone, status: 'success', channel: 'sms' });
              hasSuccess = true;
            } catch (smsError: any) {
              results.push({ phone: targetPhone, status: 'error', error: smsError?.message || String(smsError) });
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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
