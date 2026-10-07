// Registro único das unidades (hospitais) e seus setores.
//
// Fonte de verdade para código (HCN/HMB), nomes de exibição, coluna de origem
// na telemetria e classificação. O mesmo registro alimenta: seed do banco,
// parsing da planilha, API e frontend. Nada de "Hospital Atual".

import { UNIT_CODES, UNIT_META, isUnitCode, type UnitCode } from './unitMeta.js';

export { UNIT_CODES, isUnitCode, type UnitCode };

export type SectorKind = 'critico' | 'infra' | 'imagem' | 'hvac';

export const SECTOR_KIND_LABEL: Record<SectorKind, string> = {
  critico: 'Crítico',
  infra: 'Infraestrutura',
  imagem: 'Imagem',
  hvac: 'Climatização',
};

export interface SectorDef {
  /** Código canônico, único dentro da unidade (sem o "." inicial que alguns tags SQL trazem). */
  code: string;
  /** Nome da coluna na planilha de telemetria. */
  sourceColumn: string;
  name: string;
  kind: SectorKind;
  /** Setor de climatização associado — usado só para enriquecer a causa provável. */
  relatedHvac?: string;
  /** false = coluna é gravada, mas nunca gera alerta. */
  monitored: boolean;
}

export interface UnitDef {
  code: UnitCode;
  name: string;
  /** cor de identidade da unidade — a mesma no painel, no PDF e no Excel */
  accent: string;
  timezone: string;
  /** Intervalo esperado entre leituras. HCN = 15 min, HMB = 10 min. */
  expectedIntervalMin: number;
  /** Export CSV público da aba de telemetria (fonte durante a migração para o banco). */
  sheetCsvUrl: string | null;
  sectors: SectorDef[];
}

const TZ = 'America/Sao_Paulo';

function sector(
  code: string,
  name: string,
  kind: SectorKind,
  extra: { sourceColumn?: string; relatedHvac?: string; monitored?: boolean } = {}
): SectorDef {
  return {
    code,
    sourceColumn: extra.sourceColumn ?? code,
    name,
    kind,
    relatedHvac: extra.relatedHvac,
    monitored: extra.monitored ?? true,
  };
}

const HCN: UnitDef = {
  code: 'HCN',
  name: 'HCN',
  accent: UNIT_META.HCN.accent,
  timezone: TZ,
  expectedIntervalMin: 15,
  sheetCsvUrl:
    'https://docs.google.com/spreadsheets/d/15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs/export?format=csv&gid=681869284',
  sectors: [
    sector('DJ1_Lavanderia', 'Lavanderia', 'infra', { relatedHvac: 'ME_CLIM_LAVANDERIA' }),
    sector('DJ7_Oncologia', 'Oncologia', 'critico', { relatedHvac: 'ME_CLIM_ONC_A_T' }),
    sector('DJ13_Laboratorio', 'Laboratório', 'critico', { relatedHvac: 'ME_CLIM_LABORATORIO' }),
    sector('DJ40_Refeitorio', 'Refeitório', 'infra', { relatedHvac: 'ME_CLIM_REF' }),
    sector('DJ50_CME', 'CME', 'critico', { relatedHvac: 'ME_CLIM_CC_CO_CME' }),
    sector('SADT', 'SADT', 'critico'),
    sector('ME_UTI_QG_E3', 'UTI QG', 'critico', { relatedHvac: 'ME_CLIM_UTI' }),
    sector('ME_UTI_QD_IT', 'UTI QD IT', 'critico', { relatedHvac: 'ME_CLIM_UTI' }),
    sector('DJ14_Radiologia', 'Radiologia', 'imagem'),
    sector('DJ60_RM', 'Ressonância', 'imagem'),
    sector('DJ61_Tomografia', 'Tomografia', 'imagem'),
    sector('DJ58_RX1', 'Raios-X 1', 'imagem'),
    sector('DJ59_RX2', 'Raios-X 2', 'imagem'),
    sector('ME_CLIM_ONC_A_T', 'HVAC Oncologia', 'hvac'),
    sector('ME_CLIM_REF', 'HVAC Refeitório', 'hvac'),
    // Estas duas colunas vêm do SQL com "." inicial no nome do tag.
    sector('ME_CLIM_LAVANDERIA', 'HVAC Lavanderia', 'hvac', { sourceColumn: '.ME_CLIM_LAVANDERIA' }),
    sector('ME_CLIM_UTI', 'HVAC UTI', 'hvac', { sourceColumn: '.ME_CLIM_UTI' }),
    sector('ME_CLIM_CC_CO_CME', 'HVAC CME', 'hvac'),
    sector('ME_CLIM_EMERGENCIA', 'HVAC Emergência', 'hvac'),
    sector('ME_CLIM_AMBULATORIO', 'HVAC Ambulatório', 'hvac'),
    sector('ME_CLIM_LABORATORIO', 'HVAC Laboratório', 'hvac'),
  ],
};

const HMB: UnitDef = {
  code: 'HMB',
  name: 'HMB',
  accent: UNIT_META.HMB.accent,
  timezone: TZ,
  expectedIntervalMin: 10,
  sheetCsvUrl:
    'https://docs.google.com/spreadsheets/d/1_pkDSva4K9pgqXgTM3jCMdU5cbNDKEVMyzRWIC0Hihc/export?format=csv&gid=370261008',
  sectors: [
    sector('ME_CME_hmb', 'CME', 'critico'),
    sector('ME_LABOR_hmb', 'Laboratório', 'critico'),
    sector('ME_LACTARIO_hmb', 'Lactário', 'critico'),
    sector('ME_AR_COMP_hmb', 'Ar Comprimido', 'critico'),
    sector('ME_VACUO_hmb', 'Vácuo', 'critico'),
    sector('ME_QGBT_EMERGENCIA_hmb', 'QGBT Emergência', 'critico'),
    sector('ME_COZINHA_hmb', 'Cozinha', 'infra'),
    sector('ME_QGBT_E_16_hmb', 'QGBT E-16', 'infra'),
    sector('ME_QGBT_E_17_hmb', 'QGBT E-17', 'infra'),
    sector('ME_QGBT_E_18_hmb', 'QGBT E-18', 'infra'),
    sector('ME_QGBT_E_19_hmb', 'QGBT E-19', 'infra'),
    sector('ME_QGBT_E_28_hmb', 'QGBT E-28', 'infra'),
    sector('ME_QGBT_N_30_hmb', 'QGBT N-30', 'infra'),
    sector('ME_TOMO_hmb', 'Tomografia', 'imagem'),
    sector('ME_RAIOX01_hmb', 'Raios-X 1', 'imagem'),
    sector('ME_RAIOX02_hmb', 'Raios-X 2', 'imagem'),
    sector('ME_CAG01_hmb', 'Central de Água Gelada 1', 'hvac'),
    sector('ME_CAG02_hmb', 'Central de Água Gelada 2', 'hvac'),
    // Medição de entrada da concessionária (total do prédio) — gravada, nunca monitorada.
    sector('ME_ENEL_hmb', 'Entrada ENEL', 'infra', { monitored: false }),
  ],
};

export const UNITS: Record<UnitCode, UnitDef> = { HCN, HMB };

/**
 * Aceita os códigos novos e os apelidos legados (`atual`, `default`, vazio ⇒ HCN)
 * usados pelo `?hospital=` do cron e pelo Apps Script. Devolve `null` para
 * valores desconhecidos — o chamador decide se rejeita (nunca "cai" em outra unidade).
 */
export function resolveUnitCode(raw: unknown): UnitCode | null {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === '' || v === 'ATUAL' || v === 'DEFAULT') return 'HCN';
  return isUnitCode(v) ? v : null;
}

export function getUnit(code: UnitCode): UnitDef {
  return UNITS[code];
}

export function monitoredSectors(unit: UnitDef): SectorDef[] {
  return unit.sectors.filter(s => s.monitored);
}

export function findSector(unit: UnitDef, code: string): SectorDef | undefined {
  return unit.sectors.find(s => s.code === code);
}
