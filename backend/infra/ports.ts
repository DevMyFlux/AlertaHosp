// Fronteiras do sistema com o mundo externo, como interfaces — o serviço de
// ciclo depende delas, não de Vonage/Google. Nos testes entram implementações
// em memória; em produção, as reais (backend/infra/vonage.ts, sheetSource.ts).

import type { UnitCode, UnitDef } from '../../core/units.js';

/** Fonte de telemetria bruta (hoje: planilha Google; amanhã: ingestão direta). */
export interface TelemetrySource {
  /**
   * Linhas mais recentes da telemetria como objetos coluna → texto, na ordem da
   * fonte (a planilha tem o mais novo no topo). `limit = 'all'` baixa tudo.
   */
  fetchRows(unit: UnitDef, limit: number | 'all'): Promise<Record<string, string>[]>;
}

export interface DigestMessage {
  unitCode: UnitCode;
  /** 9 variáveis do template WhatsApp */
  params: string[];
  /** texto de contingência (SMS) */
  smsText: string;
  /** setor principal, usado só no fallback genérico */
  sectorLabel: string;
  /** número do consumo do setor principal (fallback genérico) */
  valueLabel: string;
}

export interface RecipientResult {
  recipientMasked: string;
  /** id da mensagem na Vonage — liga o retorno assíncrono (webhook) à notificação */
  messageUuid?: string;
  status: 'success' | 'error';
  channel?: 'whatsapp' | 'sms';
  template?: string;
  whatsappError?: string;
  error?: string;
}

export interface SendOutcome {
  ok: boolean;
  results: RecipientResult[];
  error?: string;
}

export interface NotifierDescription {
  /** null = pronto para enviar; senão, o que falta configurar */
  problem: string | null;
  recipientsMasked: string[];
  template: string;
}

export interface Notifier {
  describe(unitCode: UnitCode): NotifierDescription;
  sendDigest(message: DigestMessage): Promise<SendOutcome>;
  /** mensagem de teste para os destinatários da unidade (rota administrativa) */
  sendTest(unitCode: UnitCode, text: string): Promise<SendOutcome>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
