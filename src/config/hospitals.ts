// Registro central de hospitais atendidos por este app. Hoje só um
// ("atual") está de fato configurado; a entrada "hmb" existe pronta pra
// receber a planilha/setores reais do HMB assim que existirem — até lá,
// fica com sheetUrl null e sectorMapping vazio de propósito (não inventamos
// nomes de setor).
//
// Pra ligar um hospital novo depois de pronto (planilha compartilhada,
// setores conhecidos), edite só a entrada correspondente aqui — nenhum
// outro arquivo precisa mudar (ver HospitalContext.tsx, que é quem
// distribui a entrada ativa pros componentes).
import { SECTORS, ALL_SECTORS } from '../types';
import { SECTOR_MAPPING } from '../lib/anomalyDetection';
import { SHEET_URL } from './sheet';

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
    sheetUrl: null,
    sectors: { INFRA: [], IMAGING: [], HVAC: [] },
    allSectors: [],
    sectorMapping: {},
  },
];

export const DEFAULT_HOSPITAL_ID = HOSPITALS[0].id;

export function getHospitalById(id: string): HospitalConfig {
  return HOSPITALS.find(h => h.id === id) || HOSPITALS[0];
}
