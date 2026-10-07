// Envio via Vonage Messages API: WhatsApp (template aprovado) com fallback
// genérico e SMS opcional. Comportamento herdado da V1 (api/lib/notify.ts), sem
// as credenciais vindas do navegador e sem telefone/remetente embutidos.
//
// A Vonage aceita o envio de forma síncrona e só informa a rejeição real da
// Meta depois, por webhook — `parseStatusWebhook` traduz esse retorno para o
// sistema registrar a falha (ver api/routes/webhooks.ts).

import { Vonage } from '@vonage/server-sdk';
import { Auth } from '@vonage/auth';
import { WhatsAppTemplate, WhatsAppLanguageCode } from '@vonage/messages';
import type { AppEnv } from './env.js';
import { maskPhone } from './env.js';
import type { DigestMessage, Logger, Notifier, RecipientResult, SendOutcome } from './ports.js';
import type { UnitCode } from '../../core/units.js';

const GENERIC_TEMPLATE = 'sistema_de_alerta';

/** Lê o motivo real da rejeição do corpo HTTP que o SDK descarta ao lançar. */
async function extractVonageErrorDetail(error: any): Promise<string> {
  const fallback = error?.message || String(error);
  const response = error?.response;
  if (!response || typeof response.text !== 'function') return fallback;
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

/** Parâmetros de template não podem ter quebra de linha nem espaços repetidos (a Meta rejeita). */
const toTemplateParam = (value: string) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1024);

export type VonageFactory = (creds: NonNullable<AppEnv['vonage']>) => Vonage;

const defaultFactory: VonageFactory = creds =>
  new Vonage(new Auth({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, applicationId: creds.applicationId, privateKey: creds.privateKey }));

export class VonageNotifier implements Notifier {
  constructor(
    private readonly env: AppEnv,
    private readonly log: Logger,
    private readonly factory: VonageFactory = defaultFactory
  ) {}

  /** Configuração suficiente para enviar? (usado pelo /api/health e pelo ciclo) */
  configurationProblem(unitCode: UnitCode): string | null {
    const cfg = this.env.units[unitCode];
    if (!this.env.vonage) return 'credenciais da Vonage ausentes (VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY)';
    if (cfg.phones.length === 0) return `destinatários ausentes (ALERT_PHONE_NUMBERS${unitCode === 'HCN' ? '' : `_${unitCode}`})`;
    if (!cfg.from) return `remetente ausente (ALERT_WHATSAPP_FROM${unitCode === 'HCN' ? '' : `_${unitCode}`})`;
    if (!cfg.templateNamespace) return `namespace do template ausente (VONAGE_WHATSAPP_TEMPLATE_NAMESPACE${unitCode === 'HCN' ? '' : `_${unitCode}`})`;
    return null;
  }

  describe(unitCode: UnitCode) {
    const cfg = this.env.units[unitCode];
    return { problem: this.configurationProblem(unitCode), recipientsMasked: cfg.phones.map(maskPhone), template: cfg.templateName };
  }

  async sendDigest(message: DigestMessage): Promise<SendOutcome> {
    const problem = this.configurationProblem(message.unitCode);
    if (problem) return { ok: false, results: [], error: `Notificação não configurada: ${problem}` };
    const cfg = this.env.units[message.unitCode];
    const vonage = this.factory(this.env.vonage!);
    const locale = (process.env.VONAGE_WHATSAPP_TEMPLATE_LOCALE || WhatsAppLanguageCode.PORTUGUESE_BR) as WhatsAppLanguageCode;
    const namespace = cfg.templateNamespace!;
    const genericName = `${namespace}:${process.env.VONAGE_WHATSAPP_TEMPLATE_NAME || GENERIC_TEMPLATE}`;
    const results: RecipientResult[] = [];

    for (const phone of cfg.phones) {
      const recipientMasked = maskPhone(phone);
      let whatsappError: string | undefined;

      // 1) template específico da unidade (9 variáveis)
      try {
        const sent = await vonage.messages.send(
          new WhatsAppTemplate({
            to: phone,
            from: cfg.from!,
            whatsapp: { policy: 'deterministic', locale },
            template: { name: `${namespace}:${cfg.templateName}`, parameters: message.params.map(toTemplateParam) },
          })
        );
        results.push({ recipientMasked, messageUuid: sent?.messageUUID, status: 'success', channel: 'whatsapp', template: cfg.templateName });
        continue;
      } catch (error) {
        whatsappError = `[${cfg.templateName}] ${await extractVonageErrorDetail(error)}`;
        this.log.warn('notification.template_failed', { unit: message.unitCode, recipient: recipientMasked, error: whatsappError });
      }

      // 2) template genérico já comprovado (hora, setor, kWh)
      try {
        const sent = await vonage.messages.send(
          new WhatsAppTemplate({
            to: phone,
            from: cfg.from!,
            whatsapp: { policy: 'deterministic', locale },
            template: {
              name: genericName,
              parameters: [
                new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                toTemplateParam(message.sectorLabel),
                toTemplateParam(message.valueLabel),
              ],
            },
          })
        );
        results.push({ recipientMasked, messageUuid: sent?.messageUUID, status: 'success', channel: 'whatsapp', template: GENERIC_TEMPLATE, whatsappError });
        continue;
      } catch (error) {
        whatsappError = `${whatsappError} | [${GENERIC_TEMPLATE}] ${await extractVonageErrorDetail(error)}`;
        this.log.warn('notification.generic_failed', { unit: message.unitCode, recipient: recipientMasked, error: whatsappError });
      }

      // 3) SMS, só para unidades com contingência habilitada
      if (!cfg.smsFallback) {
        results.push({ recipientMasked, status: 'error', error: 'WhatsApp falhou e o SMS de contingência está desativado nesta unidade', whatsappError });
        continue;
      }
      try {
        const sms = await vonage.sms.send({ to: phone, from: cfg.from!, text: message.smsText });
        const first = sms.messages?.[0] as any;
        if (first && first.status !== '0') throw new Error(first.errorText || first['error-text'] || first.status);
        results.push({ recipientMasked, status: 'success', channel: 'sms', whatsappError });
      } catch (error: any) {
        results.push({ recipientMasked, status: 'error', error: error?.message || String(error), whatsappError });
      }
    }

    const ok = results.some(r => r.status === 'success');
    return ok ? { ok, results } : { ok, results, error: 'Nenhum destinatário recebeu a mensagem' };
  }

  async sendTest(unitCode: UnitCode, text: string): Promise<SendOutcome> {
    return this.sendDigest({
      unitCode,
      params: ['TESTE', `${unitCode} - TESTE`, '0%', '0 kWh', 'R$ 0,00', 'R$ 0,00', 'mensagem de teste', text, 'nenhuma ação necessária'],
      smsText: `Teste de notificação ${unitCode}: ${text}`,
      sectorLabel: `${unitCode} - TESTE`,
      valueLabel: '0',
    });
  }
}

/** Resumo seguro do retorno assíncrono da Vonage (webhook de status). */
export function parseStatusWebhook(body: unknown): { messageUuid: string | null; status: string | null; error: string | null } {
  const b = (body ?? {}) as Record<string, any>;
  return {
    messageUuid: typeof b.message_uuid === 'string' ? b.message_uuid : null,
    status: typeof b.status === 'string' ? b.status : null,
    error: b.error?.title || b.error?.detail || null,
  };
}
