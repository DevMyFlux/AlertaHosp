// Configuração lida do ambiente — única porta de entrada de variáveis de
// ambiente do backend. Valida uma vez, nunca loga valores e nunca devolve
// segredos em respostas HTTP.
//
// Compatibilidade: os nomes de variável já configurados na Vercel (HCN sem
// sufixo; HMB com sufixo _HMB) continuam valendo — nada precisa ser renomeado.

import { UNIT_CODES, type UnitCode } from '../../core/units.js';

export interface VonageCredentials {
  apiKey: string;
  apiSecret: string;
  applicationId: string;
  privateKey: string;
}

export interface UnitNotifyConfig {
  /** destinatários (formato internacional, sem "+") */
  phones: string[];
  /** remetente WhatsApp */
  from: string | null;
  /** namespace da WABA onde o template está aprovado */
  templateNamespace: string | null;
  /** template principal (9 variáveis) */
  templateName: string;
  /** SMS se o WhatsApp falhar nas duas tentativas */
  smsFallback: boolean;
  /** segredo que autoriza /api/cron-check?hospital=… deste hospital (Authorization: Bearer) */
  cronSecret: string | null;
  /** chave de ingestão direta (POST /api/ingest) deste hospital */
  ingestKey: string | null;
}

export interface AppEnv {
  databaseUrl: string | null;
  databaseSsl: 'default' | 'require' | 'no-verify' | 'disable';
  vonage: VonageCredentials | null;
  units: Record<UnitCode, UnitNotifyConfig>;
  /** senha de acesso da equipe ao painel (opcional); habilita login e ações administrativas */
  accessPassword: string | null;
  sessionSecret: string | null;
  /** avalia e grava tudo, mas não envia mensagens (validação em paralelo ao motor antigo) */
  shadowMode: boolean;
  nodeEnv: string;
}

/** Templates aprovados na Meta, por unidade (não são segredo). */
const UNIT_TEMPLATES: Record<UnitCode, { name: string; smsFallback: boolean }> = {
  HCN: { name: 'alerta_consumo_inteligente_v1', smsFallback: true },
  HMB: { name: 'alerta_consumo_inteligente_hmb_v1', smsFallback: false },
};

/**
 * Identificadores públicos da WABA do HCN que a V1 trazia embutidos no código.
 * Não são credenciais nem dados pessoais; ficam aqui como padrão do HCN para o
 * envio não quebrar caso as variáveis ainda não estejam configuradas — o ideal é
 * configurá-las na Vercel e remover este bloco. (O destinatário NÃO tem padrão:
 * telefone é dado pessoal e só vem de ALERT_PHONE_NUMBERS.)
 */
const LEGACY_DEFAULTS: Partial<Record<UnitCode, { from: string; templateNamespace: string }>> = {
  HCN: { from: '556298792013', templateNamespace: '678e6487_99c4_4e6d_995c_3dab76a2438b' },
};

function suffixFor(code: UnitCode): string {
  return code === 'HCN' ? '' : `_${code}`;
}

function read(env: NodeJS.ProcessEnv, base: string, code: UnitCode): string | null {
  const v = env[`${base}${suffixFor(code)}`];
  return v && v.trim() ? v.trim() : null;
}

function parsePhones(raw: string | null): string[] {
  if (!raw) return [];
  // aceita vírgula, ponto-e-vírgula ou espaço (o HMB já foi salvo com espaço por engano uma vez)
  return raw
    .split(/[\s,;]+/)
    .map(p => p.replace(/\D/g, ''))
    .filter(p => p.length >= 10);
}

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const vonage =
    env.VONAGE_API_KEY && env.VONAGE_API_SECRET && env.VONAGE_APPLICATION_ID && env.VONAGE_PRIVATE_KEY
      ? {
          apiKey: env.VONAGE_API_KEY,
          apiSecret: env.VONAGE_API_SECRET,
          applicationId: env.VONAGE_APPLICATION_ID,
          privateKey: env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }
      : null;

  const units = {} as Record<UnitCode, UnitNotifyConfig>;
  for (const code of UNIT_CODES) {
    units[code] = {
      phones: parsePhones(read(env, 'ALERT_PHONE_NUMBERS', code)),
      from: read(env, 'ALERT_WHATSAPP_FROM', code) ?? LEGACY_DEFAULTS[code]?.from ?? null,
      templateNamespace: read(env, 'VONAGE_WHATSAPP_TEMPLATE_NAMESPACE', code) ?? LEGACY_DEFAULTS[code]?.templateNamespace ?? null,
      templateName: UNIT_TEMPLATES[code].name,
      smsFallback: UNIT_TEMPLATES[code].smsFallback,
      cronSecret: read(env, 'CRON_SECRET', code),
      ingestKey: read(env, 'INGEST_KEY', code),
    };
  }

  const ssl = (env.DATABASE_SSL ?? 'default') as AppEnv['databaseSsl'];
  return {
    databaseUrl: env.DATABASE_URL?.trim() || null,
    databaseSsl: ['default', 'require', 'no-verify', 'disable'].includes(ssl) ? ssl : 'default',
    vonage,
    units,
    accessPassword: env.APP_ACCESS_PASSWORD?.trim() || null,
    sessionSecret: env.SESSION_SECRET?.trim() || null,
    shadowMode: env.V2_SHADOW_MODE === 'true' || env.V2_SHADOW_MODE === '1',
    nodeEnv: env.NODE_ENV ?? 'development',
  };
}

/** Máscara para registrar destinatários sem expor o número inteiro. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
