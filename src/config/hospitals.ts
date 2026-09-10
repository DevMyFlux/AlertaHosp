// Registro central de hospitais atendidos por este app.
//
// - "atual" (HCN): totalmente configurado, em produção. Re-exporta as
//   constantes históricas (SHEET_URL, SECTORS, SECTOR_MAPPING) sem alterar
//   nenhum valor.
// - "hmb": setores já preenchidos (descobertos no schema do SQL Server do
//   HMB — tabela hmb2.dbo.Totalizadores_Disjuntores). Falta só a `sheetUrl`
//   da planilha de telemetria do HMB, que ainda não existe — assim que ela
//   for criada e compartilhada (link público de leitura), basta colar a URL
//   de export CSV em HMB_SHEET_URL abaixo.
//
// Pra ligar/ajustar um hospital, edite só a entrada correspondente aqui —
// nenhum outro arquivo do frontend precisa mudar (HospitalContext.tsx
// distribui a entrada ativa pros componentes). O backend espelha esta
// config em api/lib/hospitalRuntime.ts.
// Extensões .js explícitas: este módulo é importado tanto pelo frontend
// (Vite, resolve sem extensão) quanto pelo backend serverless via
// api/lib/hospitalRuntime.ts (o bundler da Vercel exige a extensão, igual
// aos outros imports de src/ feitos por api/).
import { SECTORS, ALL_SECTORS } from '../types.js';
import { SECTOR_MAPPING, UNIFIED_TEMPLATE_NAME } from '../lib/anomalyDetection.js';
import { SHEET_URL } from './sheet.js';

export interface SectorMappingEntry {
  label: string;
  sub?: string;
  type: string;
  template?: string;
}

export interface HospitalConfig {
  id: string;
  label: string;
  /** URL pública de export CSV da planilha de telemetria. `null` = hospital
   *  ainda não tem planilha configurada (mostra estado vazio, não mock). */
  sheetUrl: string | null;
  sectors: { INFRA: string[]; IMAGING: string[]; HVAC: string[] };
  allSectors: string[];
  sectorMapping: Record<string, SectorMappingEntry>;
}

// ─────────────────────────────────────────────────────────────────────────
// HMB
// ─────────────────────────────────────────────────────────────────────────

// URL de export CSV da aba "Telemetria" (gid 370261008) da planilha do HMB
// (1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc — a mesma que guarda a aba
// "EstadoAlertas"). A aba fica vazia até o enviar_sheets_hmb.py rodar na
// máquina física; enquanto não houver dados, as telas do HMB aparecem
// vazias (sem erro), não "SEM PLANILHA".
const HMB_SHEET_URL: string | null =
  'https://docs.google.com/spreadsheets/d/1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc/export?format=csv&gid=370261008';

// Colunas reais da tabela hmb2.dbo.Totalizadores_Disjuntores (cada uma tem
// também uma coluna `<nome>_Quality` na telemetria). ME_ENEL_hmb é a medição
// de entrada da distribuidora (total do prédio), não um setor consumidor —
// fica de fora do monitoramento de anomalia de propósito.
const HMB_SECTORS = {
  IMAGING: ['ME_TOMO_hmb', 'ME_RAIOX01_hmb', 'ME_RAIOX02_hmb'],
  HVAC: ['ME_CAG01_hmb', 'ME_CAG02_hmb'],
  INFRA: [
    'ME_CME_hmb', 'ME_LABOR_hmb', 'ME_LACTARIO_hmb', 'ME_AR_COMP_hmb', 'ME_VACUO_hmb',
    'ME_QGBT_EMERGENCIA_hmb', 'ME_COZINHA_hmb',
    'ME_QGBT_E_16_hmb', 'ME_QGBT_E_17_hmb', 'ME_QGBT_E_18_hmb', 'ME_QGBT_E_19_hmb',
    'ME_QGBT_E_28_hmb', 'ME_QGBT_N_30_hmb',
  ],
};

// `type` (Infra/Crítico/Imagem/HVAC) alimenta perfil de causa/ação e
// severidade (ver anomalyDetection.ts). `label` é só rótulo de exibição —
// ajuste livremente conforme a nomenclatura oficial do HMB. `template`:
// mesmo template WhatsApp do HCN (decidido: mesmo número/template, só
// destinatários diferentes).
const HMB_SECTOR_MAPPING: Record<string, SectorMappingEntry> = {
  'ME_CME_hmb': { label: 'CME', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_LABOR_hmb': { label: 'Laboratório', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_LACTARIO_hmb': { label: 'Lactário', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_AR_COMP_hmb': { label: 'Ar Comprimido', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_VACUO_hmb': { label: 'Vácuo', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_EMERGENCIA_hmb': { label: 'QGBT Emergência', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_COZINHA_hmb': { label: 'Cozinha', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_E_16_hmb': { label: 'QGBT E-16', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_E_17_hmb': { label: 'QGBT E-17', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_E_18_hmb': { label: 'QGBT E-18', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_E_19_hmb': { label: 'QGBT E-19', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_E_28_hmb': { label: 'QGBT E-28', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_QGBT_N_30_hmb': { label: 'QGBT N-30', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'ME_TOMO_hmb': { label: 'Tomografia', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'ME_RAIOX01_hmb': { label: 'Raios-X 1', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'ME_RAIOX02_hmb': { label: 'Raios-X 2', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'ME_CAG01_hmb': { label: 'Central de Água Gelada 1', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CAG02_hmb': { label: 'Central de Água Gelada 2', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
};

const HMB_ALL_SECTORS = [...HMB_SECTORS.INFRA, ...HMB_SECTORS.IMAGING, ...HMB_SECTORS.HVAC];

export const HOSPITALS: HospitalConfig[] = [
  {
    id: 'atual',
    label: 'Hospital Atual',
    sheetUrl: SHEET_URL,
    sectors: SECTORS,
    allSectors: ALL_SECTORS,
    sectorMapping: SECTOR_MAPPING,
  },
  {
    id: 'hmb',
    label: 'HMB',
    sheetUrl: HMB_SHEET_URL,
    sectors: HMB_SECTORS,
    allSectors: HMB_ALL_SECTORS,
    sectorMapping: HMB_SECTOR_MAPPING,
  },
];

export const DEFAULT_HOSPITAL_ID = HOSPITALS[0].id;

export function getHospitalById(id: string): HospitalConfig {
  return HOSPITALS.find(h => h.id === id) || HOSPITALS[0];
}
