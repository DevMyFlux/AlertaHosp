// Resolve, para um `?hospital=` recebido nas rotas do backend, tudo que o
// ciclo de alerta precisa daquele hospital: planilha de telemetria, setores,
// mapeamento, ponte com a planilha de estado (Apps Script) e destinatários.
//
// Combina duas fontes:
//   - estática, versionada:  src/config/hospitals.ts  (sheetUrl, setores,
//     sectorMapping) — a mesma que o frontend usa;
//   - secreta, só em env var: URL do Web App, segredo compartilhado e
//     telefones — NUNCA no código.
//
// Compatibilidade: o hospital atual (HCN) usa os nomes de env var
// históricos, sem sufixo (SHEETS_WEBAPP_URL, CRON_SECRET,
// ALERT_PHONE_NUMBERS, ALERT_WHATSAPP_FROM). Qualquer outro hospital usa os
// mesmos nomes com SUFIXO _<ID> em maiúsculo (ex: SHEETS_WEBAPP_URL_HMB).
// Assim o fluxo do HCN em produção não muda nada.
import { getHospitalById, type HospitalConfig } from '../../src/config/hospitals.js';
import type { SheetsBridgeConfig } from './sheetsBridge.js';

export const DEFAULT_HOSPITAL_ID = 'atual';

// Aceita 'hcn' / 'atual' / vazio como o hospital atual — 'hcn' é a
// nomenclatura usada fora do frontend (Apps Script, scripts da máquina).
function normalizeHospitalId(raw: string | undefined | null): string {
  const v = (raw || '').trim().toLowerCase();
  if (!v || v === 'hcn' || v === 'atual' || v === 'default') return DEFAULT_HOSPITAL_ID;
  return v;
}

export interface HospitalRuntime {
  id: string;
  label: string;
  /** Planilha de telemetria (export CSV). null = hospital ainda sem planilha. */
  sheetUrl: string | null;
  allSectors: string[];
  sectorMapping: HospitalConfig['sectorMapping'];
  /** Ponte com a planilha de estado de alertas desse hospital. null = não configurada. */
  bridge: SheetsBridgeConfig | null;
  /** Segredo que o cron-check desse hospital exige no header/secret. */
  cronSecret: string | undefined;
  /** Destinatários dos alertas automáticos (formato Vonage, vírgula-separado). */
  alertPhones: string | undefined;
  /** Remetente WhatsApp usado pelo cron desse hospital. */
  alertWhatsappFrom: string | undefined;
}

function envFor(id: string, base: string): string | undefined {
  if (id === DEFAULT_HOSPITAL_ID) return process.env[base];
  return process.env[`${base}_${id.toUpperCase()}`];
}

export function resolveHospitalRuntime(rawId: string | undefined | null): HospitalRuntime {
  const id = normalizeHospitalId(rawId);
  // getHospitalById cai no hospital atual se o id for desconhecido — um
  // ?hospital= inválido não vira bypass de auth: ainda exige o segredo do HCN.
  const cfg = getHospitalById(id);
  const webappUrl = envFor(cfg.id, 'SHEETS_WEBAPP_URL');
  const secret = envFor(cfg.id, 'CRON_SECRET');
  return {
    id: cfg.id,
    label: cfg.label,
    sheetUrl: cfg.sheetUrl,
    allSectors: cfg.allSectors,
    sectorMapping: cfg.sectorMapping,
    bridge: webappUrl && secret ? { webappUrl, secret } : null,
    cronSecret: secret,
    alertPhones: envFor(cfg.id, 'ALERT_PHONE_NUMBERS'),
    alertWhatsappFrom: envFor(cfg.id, 'ALERT_WHATSAPP_FROM'),
  };
}
