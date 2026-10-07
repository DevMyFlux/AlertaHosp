// Causa provável e ação recomendada por setor/tipo, em linguagem direta (sem
// jargão de marca). Texto herdado da V1 (aprovado pelo cliente nos templates
// do WhatsApp) — agora num só lugar, sem a cópia que existia em três telas.

import type { SectorKind } from '../units.js';

export interface CauseProfile {
  /** frase curta para {{8}} do template WhatsApp */
  cause: string;
  /** complemento nominal para {{9}}: encaixa em "verificar {{9}}." */
  action: string;
  /** versão longa (SMS / painel) */
  causeLong: string;
  actionLong: string;
}

// Perfis específicos por setor (chave = código canônico do setor).
const SECTOR_PROFILES: Record<string, CauseProfile> = {
  DJ50_CME: {
    cause: 'uso simultâneo de autoclaves e climatização fora do perfil habitual',
    action: 'a climatização local, as autoclaves e os equipamentos de apoio',
    causeLong: 'carga térmica elevada ou equipamento de processo operando fora do comportamento habitual',
    actionLong: 'Recomenda-se verificar a climatização local e os equipamentos de apoio (autoclaves).',
  },
  ME_CME_hmb: {
    cause: 'uso simultâneo de autoclaves e climatização fora do perfil habitual',
    action: 'a climatização local, as autoclaves e os equipamentos de apoio',
    causeLong: 'carga térmica elevada ou equipamento de processo operando fora do comportamento habitual',
    actionLong: 'Recomenda-se verificar a climatização local e os equipamentos de apoio (autoclaves).',
  },
  DJ13_Laboratorio: {
    cause: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    action: 'os equipamentos de análise em uso e os refrigeradores/freezers do setor',
    causeLong: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    actionLong: 'Recomenda-se verificar os equipamentos de análise em uso e o funcionamento dos refrigeradores/freezers do setor.',
  },
  ME_LABOR_hmb: {
    cause: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    action: 'os equipamentos de análise em uso e os refrigeradores/freezers do setor',
    causeLong: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    actionLong: 'Recomenda-se verificar os equipamentos de análise em uso e o funcionamento dos refrigeradores/freezers do setor.',
  },
};

const KIND_PROFILES: Record<SectorKind, CauseProfile> = {
  critico: {
    cause: 'uso simultâneo de equipamentos de suporte à vida acima do padrão habitual',
    action: 'os equipamentos essenciais em uso junto à enfermaria ou supervisão do setor',
    causeLong: 'carga elevada de equipamentos essenciais ou pico de demanda simultânea',
    actionLong:
      'Recomenda-se confirmar com a enfermaria ou supervisão do setor o uso extraordinário de equipamentos. Evitar desligamentos sem validação clínica.',
  },
  imagem: {
    cause: 'exames de alta demanda em sequência ou sobrecarga térmica dos equipamentos',
    action: 'a agenda de exames, o sistema de refrigeração e os equipamentos de diagnóstico',
    causeLong: 'carga térmica do equipamento ou exame de longa duração fora do padrão',
    actionLong: 'Recomenda-se verificar o sistema de refrigeração do equipamento e a agenda de exames do período.',
  },
  hvac: {
    cause: 'sistema de climatização operando acima da carga térmica habitual',
    action: 'os filtros, compressores, setpoint e funcionamento da climatização',
    causeLong: 'carga térmica elevada ou equipamento de climatização fora do padrão de funcionamento',
    actionLong: 'Recomenda-se verificar filtros, compressor e o ajuste do termostato do sistema de climatização.',
  },
  infra: {
    cause: 'equipamentos ou iluminação operando fora do horário previsto',
    action: 'a iluminação, os equipamentos auxiliares e as cargas não essenciais',
    causeLong: 'equipamento ou iluminação em operação fora do horário previsto',
    actionLong: 'Recomenda-se verificar equipamentos e iluminação do setor.',
  },
};

const HVAC_RELATED: CauseProfile = {
  cause: 'climatização operando fora da curva normal',
  action: 'a climatização local e os equipamentos de apoio',
  causeLong: 'climatização operando fora da curva normal',
  actionLong: 'Recomenda-se verificar climatização local e equipamentos de apoio.',
};

/**
 * @param hvacElevated true quando o setor de climatização associado também está
 *   bem acima do esperado — aponta a causa para a climatização.
 */
export function causeProfile(sectorCode: string, kind: SectorKind, hvacElevated = false): CauseProfile {
  if (hvacElevated) return HVAC_RELATED;
  return SECTOR_PROFILES[sectorCode] ?? KIND_PROFILES[kind] ?? KIND_PROFILES.infra;
}
