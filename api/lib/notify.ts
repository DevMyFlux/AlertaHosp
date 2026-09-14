import { Vonage } from '@vonage/server-sdk';
import { Auth } from '@vonage/auth';
import { WhatsAppTemplate, WhatsAppLanguageCode } from '@vonage/messages';

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

// O corpo fixo do template "sistema_de_alerta" espera um número de kWh puro
// em {{3}} (ex: "5,6"), não um parágrafo — ver resolveKwhParam/{{3}} abaixo.
// `valor` é o dado limpo que LiveMonitorView/DiagnosticsView (ou o cron
// server-side) já têm (leitura de telemetria); quando ausente, tentamos
// extrair o primeiro número presente na mensagem antes de recorrer a um
// placeholder.
function resolveKwhParam(valor: unknown, message: string): string {
  const trimmedValor = typeof valor === 'string' ? valor.trim() : valor;
  if (trimmedValor !== undefined && trimmedValor !== null && trimmedValor !== '') {
    return String(trimmedValor).replace(/\s+/g, ' ').trim().slice(0, 1024);
  }
  const match = String(message ?? '').match(/-?\d+(?:[.,]\d+)?/);
  if (match) return match[0];
  return 'N/D';
}

export interface SendAlertParams {
  message: string;
  sector: string;
  valor?: unknown;
  phone?: string;
  appId?: string;
  privateKey?: string;
  whatsappFrom?: string;
  templateOverride?: string;
  templateParams?: unknown[];
  /** Namespace da WABA (WhatsApp Business Account) onde o template está
   *  aprovado. Cada hospital pode ter seu próprio número/WABA/namespace
   *  (ver api/lib/hospitalRuntime.ts) — sem isso, um hospital com WABA
   *  diferente do HCN tenta enviar no namespace errado e o template nunca
   *  é encontrado (cai direto pro fallback/SMS). Omitido = comportamento
   *  anterior (env global / namespace do HCN). */
  templateNamespace?: string;
}

export interface SendAlertResultEntry {
  phone: string;
  status: 'success' | 'error';
  channel?: 'whatsapp' | 'sms';
  template?: string;
  whatsappError?: string;
  error?: string;
}

export type SendAlertResult =
  | { ok: true; results: SendAlertResultEntry[] }
  | { ok: false; status: number; error: string; results?: SendAlertResultEntry[] };

// Lógica de envio via Vonage (WhatsApp Template com fallback pra SMS)
// compartilhada entre a rota HTTP /api/notify (disparo manual/do frontend) e
// o cron server-side /api/cron-check (disparo automático, independente de
// qualquer navegador estar aberto) — extraída de api/app.ts pra não haver
// duas implementações divergindo com o tempo.
export async function sendAlertNotification(params: SendAlertParams): Promise<SendAlertResult> {
  const { message, sector, valor, phone, appId, privateKey, whatsappFrom, templateOverride, templateParams, templateNamespace: templateNamespaceParam } = params;
  const to = phone || '5511949102183'; // Default se não for enviado
  const from = whatsappFrom || '556298792013'; // Sender for WhatsApp

  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  // As variáveis de ambiente do servidor têm prioridade: são a fonte
  // confiável e mantida atualizada. appId/privateKey salvos no navegador
  // (tela de Configurações) só são usados como fallback, quando o servidor
  // não tem credenciais configuradas — caso contrário um valor antigo salvo
  // ali (de testes passados) sobrescreveria silenciosamente a configuração
  // correta, causando falha na Application/template sem erro aparente.
  const applicationId = process.env.VONAGE_APPLICATION_ID || appId;
  const rawPrivateKey = process.env.VONAGE_PRIVATE_KEY || privateKey;

  if (!apiKey || !apiSecret || !applicationId || !rawPrivateKey) {
    return {
      ok: false,
      status: 500,
      error: 'Credenciais da Vonage não configuradas. Defina VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID e VONAGE_PRIVATE_KEY nas variáveis de ambiente.',
    };
  }

  const pk = rawPrivateKey.replace(/\\n/g, '\n');

  // Mensagens de WhatsApp iniciadas pela empresa (fora de uma janela de
  // conversa ativa de 24h) só são entregues pela Meta se usarem um Message
  // Template pré-aprovado, referenciado como "namespace:nome_do_template"
  // (a WABA vinculada ao número já tem o template "sistema_de_alerta"
  // aprovado e em uso pelo sistema legado em Java).
  //
  // O namespace é por WABA (Business Account), não por app Vonage — cada
  // número/hospital pode estar numa WABA diferente com namespace diferente
  // (ver templateNamespace em SendAlertParams / hospitalRuntime.ts). Sem
  // `templateNamespaceParam`, cai no comportamento de sempre (env global,
  // depois o namespace hardcoded do HCN).
  const templateNamespace = templateNamespaceParam
    || process.env.VONAGE_WHATSAPP_TEMPLATE_NAMESPACE
    || '678e6487_99c4_4e6d_995c_3dab76a2438b';
  const templateNameOnly = process.env.VONAGE_WHATSAPP_TEMPLATE_NAME || 'sistema_de_alerta';
  const templateName = `${templateNamespace}:${templateNameOnly}`;
  const templateLocale = (process.env.VONAGE_WHATSAPP_TEMPLATE_LOCALE || WhatsAppLanguageCode.PORTUGUESE_BR) as WhatsAppLanguageCode;
  const horaFormatada = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  // Parâmetros de template do WhatsApp não podem conter quebras de linha nem
  // espaços múltiplos, ou a Meta rejeita a mensagem. Também truncamos no
  // limite documentado da Meta (1024 caracteres) como proteção extra.
  const toTemplateParam = (value: string) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1024);

  try {
    const dynamicVonage = new Vonage(new Auth({ apiKey, apiSecret, applicationId, privateKey: pk }));

    // We will try to send to multiple numbers if 'phone' is a comma separated string
    const phones = phone ? phone.split(',').map((p: string) => p.trim()) : [to];

    const results: SendAlertResultEntry[] = [];
    let hasSuccess = false;

    // Setores com um template específico aprovado (ver SECTOR_MAPPING no
    // frontend) usam esse template primeiro; se ele falhar (nome/parâmetros
    // ainda não confirmados contra o texto real aprovado na Meta), caímos
    // pro "sistema_de_alerta" — já comprovado — antes de desistir pro SMS.
    const hasTemplateOverride = typeof templateOverride === 'string' && templateOverride.length > 0
      && Array.isArray(templateParams) && templateParams.length > 0;

    for (const targetPhone of phones) {
      let whatsappErrorDetail: string | undefined;

      if (hasTemplateOverride) {
        try {
          await dynamicVonage.messages.send(new WhatsAppTemplate({
            to: targetPhone,
            from: from,
            whatsapp: {
              policy: 'deterministic',
              locale: templateLocale,
            },
            template: {
              name: `${templateNamespace}:${templateOverride}`,
              parameters: templateParams!.map((p: unknown) => toTemplateParam(String(p))),
            },
          }));
          results.push({ phone: targetPhone, status: 'success', channel: 'whatsapp', template: templateOverride });
          hasSuccess = true;
          continue;
        } catch (specificError: any) {
          whatsappErrorDetail = `[${templateOverride}] ${await extractVonageErrorDetail(specificError)}`;
          console.warn(`Template específico (${templateOverride}) falhou para ${targetPhone}, tentando sistema_de_alerta:`, whatsappErrorDetail);
        }
      }

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
            parameters: [horaFormatada, toTemplateParam(sector), resolveKwhParam(valor, message)],
          },
        }));
        results.push({ phone: targetPhone, status: 'success', channel: 'whatsapp', template: templateNameOnly, whatsappError: whatsappErrorDetail });
        hasSuccess = true;
        continue;
      } catch (wppError: any) {
        const genericErrorDetail = `[${templateNameOnly}] ${await extractVonageErrorDetail(wppError)}`;
        whatsappErrorDetail = whatsappErrorDetail ? `${whatsappErrorDetail} | ${genericErrorDetail}` : genericErrorDetail;
        console.warn(`WhatsApp failed for ${targetPhone}, falling back to SMS:`, whatsappErrorDetail);
      }

      try {
        // `message` já vem formatada no padrão "⚠️ ALERTA - SETOR..." (ver
        // formatStandardAlertMessage no frontend) — não duplicar aqui. Sem
        // corte de 160 caracteres: a Vonage concatena automaticamente em
        // múltiplos segmentos SMS quando o texto excede o limite de um único
        // segmento, então o texto completo (com as causas prováveis) chega
        // ao destinatário.
        const smsResponse = await dynamicVonage.sms.send({
          to: targetPhone,
          from: from,
          text: String(message ?? ''),
        });

        if (smsResponse.messages && smsResponse.messages[0].status !== '0') {
          const firstMessage = smsResponse.messages[0] as any;
          throw new Error(firstMessage.errorText || firstMessage['error-text'] || firstMessage.status);
        }
        results.push({ phone: targetPhone, status: 'success', channel: 'sms', whatsappError: whatsappErrorDetail });
        hasSuccess = true;
      } catch (smsError: any) {
        results.push({
          phone: targetPhone,
          status: 'error',
          error: smsError?.message || String(smsError),
          whatsappError: whatsappErrorDetail,
        });
      }
    }

    if (hasSuccess) {
      return { ok: true, results };
    }
    return {
      ok: false,
      status: 401,
      error: 'Falha de Autenticação nas APIs da Vonage. Verifique suas credenciais.',
      results,
    };
  } catch (error: any) {
    console.warn('Notification Error:', error?.message || String(error));
    return { ok: false, status: 500, error: error?.message || String(error) };
  }
}
