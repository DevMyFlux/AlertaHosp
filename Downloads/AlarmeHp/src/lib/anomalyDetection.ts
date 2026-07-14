import { ProcessedTelemetryData, ALL_SECTORS } from '../types';

export type TimeBand = 'Café da Manhã (07-10h)' | 'Almoço (10-14h)' | 'Jantar (18-22h)' | 'Demais Horários';

export function getBand(hour: number): TimeBand {
  if (hour >= 7 && hour < 10) return 'Café da Manhã (07-10h)';
  if (hour >= 10 && hour < 14) return 'Almoço (10-14h)';
  if (hour >= 18 && hour < 22) return 'Jantar (18-22h)';
  return 'Demais Horários';
}

// `template`: nome (sem namespace) de um WhatsApp Message Template
// aprovado pra esse setor, com 2 parâmetros (setor, valor). Os templates
// antigos por setor (setor_laboratorio_alerta_energia2 e cia) foram criados
// na WABA errada dentro da Business Manager "Carbono Zero" (que tem 3 WABAs
// com o mesmo nome) — por isso rejeitavam sempre ("template ... does not
// exist"). Foram substituídos por 4 templates novos, um por `type`, criados
// já na WABA correta (101201763028051, a mesma do "sistema_de_alerta" que
// funciona): alerta_critico_energia, alerta_imagem_energia,
// alerta_hvac_energia, alerta_infra_energia. Se o template específico falhar
// por qualquer motivo (ex: ainda em análise na Meta), o backend cai
// automaticamente pro "sistema_de_alerta" antes de desistir pro SMS (ver
// api/app.ts) — então a falta de aprovação de um desses 4 não interrompe o
// envio, só faz o alerta sair no formato antigo até ser aprovado.
export const SECTOR_MAPPING: Record<string, { label: string; sub?: string; type: string; template?: string }> = {
  'DJ1_Lavanderia': { label: 'Lavanderia', sub: 'ME_CLIM_LAVANDERIA', type: 'Infra', template: 'alerta_infra_energia' },
  'DJ7_Oncologia': { label: 'Oncologia', sub: 'ME_CLIM_ONC_A_T', type: 'Crítico', template: 'alerta_critico_energia' },
  'DJ13_Laboratorio': { label: 'Laboratório', sub: 'ME_CLIM_LABORATORIO', type: 'Crítico', template: 'alerta_critico_energia' },
  'DJ40_Refeitorio': { label: 'Refeitório', sub: 'ME_CLIM_REF', type: 'Infra', template: 'alerta_infra_energia' },
  'DJ50_CME': { label: 'CME', sub: 'ME_CLIM_CC_CO_CME', type: 'Crítico', template: 'alerta_critico_energia' },
  'SADT': { label: 'SADT', type: 'Crítico', template: 'alerta_critico_energia' },
  'ME_UTI_QG_E3': { label: 'UTI QG', sub: 'ME_CLIM_UTI', type: 'Crítico', template: 'alerta_critico_energia' },
  'ME_UTI_QD_IT': { label: 'UTI QD IT', sub: 'ME_CLIM_UTI', type: 'Crítico', template: 'alerta_critico_energia' },
  'DJ14_Radiologia': { label: 'Radiologia', type: 'Imagem', template: 'alerta_imagem_energia' },
  'DJ60_RM': { label: 'Ressonância', type: 'Imagem', template: 'alerta_imagem_energia' },
  'DJ61_Tomografia': { label: 'Tomografia', type: 'Imagem', template: 'alerta_imagem_energia' },
  'DJ58_RX1': { label: 'Raios-X 1', type: 'Imagem', template: 'alerta_imagem_energia' },
  'DJ59_RX2': { label: 'Raios-X 2', type: 'Imagem', template: 'alerta_imagem_energia' },
  // Submetição de climatização promovida a setor próprio de alerta — os
  // dados já vêm na planilha (usados até aqui só como referência cruzada
  // via `sub`), mas nunca foram avaliados como anomalia independente.
  'ME_CLIM_ONC_A_T': { label: 'HVAC Oncologia', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_REF': { label: 'HVAC Refeitório', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_LAVANDERIA': { label: 'HVAC Lavanderia', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_UTI': { label: 'HVAC UTI', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_CC_CO_CME': { label: 'HVAC CME', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_EMERGENCIA': { label: 'HVAC Emergência', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_AMBULATORIO': { label: 'HVAC Ambulatório', type: 'HVAC', template: 'alerta_hvac_energia' },
  'ME_CLIM_LABORATORIO': { label: 'HVAC Laboratório', type: 'HVAC', template: 'alerta_hvac_energia' },
};

export interface SectorStats {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
}

export function calcStats(vals: number[]): SectorStats {
  if (!vals.length) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { mean, median, stdDev, min, max };
}

// Constrói média/mediana/desvio-padrão por setor e turno (janela de horário),
// usando todo o histórico disponível — a mesma base estatística usada tanto
// pela análise pontual (LiveMonitorView) quanto pelo relatório histórico
// (DiagnosticsView), evitando que as duas telas divirjam nos critérios de
// anomalia.
export function buildSectorBandStats(data: ProcessedTelemetryData[]): Record<string, Record<TimeBand, SectorStats>> {
  const histData: Record<string, Record<TimeBand, number[]>> = {};
  ALL_SECTORS.forEach(sec => {
    histData[sec] = {
      'Café da Manhã (07-10h)': [],
      'Almoço (10-14h)': [],
      'Jantar (18-22h)': [],
      'Demais Horários': [],
    };
  });

  data.forEach(row => {
    const band = getBand(row.hour);
    ALL_SECTORS.forEach(sec => {
      const val = Number(row[sec]);
      if (!isNaN(val) && val > 0) {
        histData[sec][band].push(val);
      }
    });
  });

  const sStats: Record<string, Record<TimeBand, SectorStats>> = {};
  ALL_SECTORS.forEach(sec => {
    sStats[sec] = {} as Record<TimeBand, SectorStats>;
    (Object.keys(histData[sec]) as TimeBand[]).forEach(band => {
      sStats[sec][band] = calcStats(histData[sec][band]);
    });
  });

  return sStats;
}

export interface SectorAnomaly {
  date: string;
  time: string;
  band: TimeBand;
  sectorName: string;
  sectorKey: string;
  type: string;
  val: number;
  mean: number;
  expectedMax: number;
  deviation: number;
  severity: 'Moderado' | 'Alto' | 'Crítico';
  subVal: number;
  subMedian: number;
  subName: string;
  // Nome (sem namespace) de um template específico pra esse setor, se
  // configurado em SECTOR_MAPPING. Ausente = usa o "sistema_de_alerta".
  templateOverride?: string;
}

const kwhFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

// Monta os parâmetros {{2}} (setor) e {{3}} (valor) do template WhatsApp
// "sistema_de_alerta". O texto fixo aprovado na Meta é uma frase pronta
// ("...o setor [LOCAL] consumiu [VALOR] kWh de energia elétrica...") — os
// parâmetros precisam encaixar como texto simples nessa frase. Antes essa
// função enfiava "(limite X, +Y%)" dentro do {{3}} e "(Crítico)" dentro do
// {{2}}, o que quebrava a gramática da frase (ex: "consumiu 1.000.003,2
// (limite 63.071,3, +1486%)kWh"). Severidade e desvio já ficam visíveis no
// dashboard (Monitoramento/AI Diagnostics) — aqui mandamos só o valor limpo.
export function formatSectorParam(sectorName: string, _severity: string): string {
  return sectorName;
}

export function formatValorParam(val: number, _expectedMax: number): string {
  return kwhFormatter.format(val);
}

// Parâmetros {{1}}/{{2}} do template setor_laboratorio_alerta_energia2 (nome
// do setor, valor). Confirmado nas "Amostras de variáveis" do template
// aprovado: {{1}} = "LABORATÓRIO" (setor em maiúsculo, sem unidade) e
// {{2}} = "125.45" (só o número, SEM "kWh" — a unidade já está fixa no
// corpo do template, logo depois da variável). Antes essa função grudava
// " kWh" no {{2}}, duplicando a unidade na mensagem final ("125,4 kWh kWh").
export function formatSetorNomeParam(sectorName: string): string {
  return sectorName.toUpperCase();
}

export function formatValorComUnidadeParam(val: number, _unidade: string = 'kWh'): string {
  return kwhFormatter.format(val);
}

// Mesmo cabeçalho usado no card do Relatório de Diagnóstico da IA — usado no
// texto que o próprio sistema controla (SMS de fallback, corpo interno da
// mensagem). O texto FIXO já aprovado dentro de cada template WhatsApp na
// Meta não pode ser alterado por aqui — só editando o template lá.
export function formatAlertHeader(sectorName: string): string {
  return `🚨 ALERTA DE ANOMALIA - ${sectorName.toUpperCase()}`;
}

// Ação de campo recomendada com base no tipo do setor (mesma classificação
// usada no Monitoramento de 15 Minutos e no Relatório de Diagnóstico da IA).
export function getActionText(anomaly: Pick<SectorAnomaly, 'type' | 'subName' | 'subVal' | 'subMedian'>): string {
  if (anomaly.type === 'Crítico') {
    return "Contatar enfermaria/supervisão local para confirmar o uso extraordinário de equipamentos (suporte à vida). Não desarmar sem validação clínica.";
  }
  if (anomaly.type === 'Imagem') {
    return "Acionar equipe de engenharia clínica. Verificar status do Chiller do equipamento e agendamento de exames em massa.";
  }
  if (anomaly.type === 'HVAC') {
    return "Acionar equipe de facilities (Refrigeração). Verificar limpeza de filtros, setpoint do termostato e possível travamento de compressor.";
  }
  if (anomaly.subName && anomaly.subVal > anomaly.subMedian * 1.3) {
    return "Acionar equipe de facilities (Refrigeração). Verificar possível travamento de compressor ou falha no termostato.";
  }
  return "Contatar equipe de manutenção imediatamente.";
}

// Causas prováveis exibidas na mensagem enviada ao destinatário, no mesmo
// estilo do template aprovado setor_laboratorio_alerta_energia2 (lista fixa
// de "Possíveis causas"). O Laboratório usa o texto já aprovado ali; os
// demais setores caem no conjunto padrão do seu `type`.
const SECTOR_SPECIFIC_CAUSES: Record<string, string[]> = {
  'DJ13_Laboratorio': [
    'Equipamentos de análise ligados',
    'Refrigerador/Freezer com mal funcionamento',
    'Centrífuga em operação contínua',
  ],
};

const TYPE_CAUSES: Record<string, string[]> = {
  'Crítico': [
    'Equipamento de suporte à vida em uso intensivo',
    'Pico de demanda simultânea de múltiplos equipamentos',
    'Possível falha elétrica local (curto-circuito)',
  ],
  'Imagem': [
    'Exame de alta demanda energética em andamento',
    'Chiller do equipamento em sobrecarga',
    'Acúmulo de exames agendados no mesmo intervalo',
  ],
  'HVAC': [
    'Compressor travado ou ciclando incorretamente',
    'Filtros de ar sujos forçando o equipamento',
    'Termostato com setpoint incorreto',
  ],
  'Infra': [
    'Equipamentos/máquinas ligados fora do horário',
    'Iluminação ou ar-condicionado esquecido ligado',
    'Uso simultâneo de múltiplos equipamentos de grande porte',
  ],
};

export function getPossibleCauses(anomaly: Pick<SectorAnomaly, 'sectorKey' | 'type'>): string[] {
  return SECTOR_SPECIFIC_CAUSES[anomaly.sectorKey] || TYPE_CAUSES[anomaly.type] || TYPE_CAUSES['Infra'];
}

// Corpo da mensagem efetivamente recebida pelo destinatário via SMS de
// fallback (quando o template WhatsApp falha) e também usado como registro
// interno do alerta — segue o mesmo padrão visual do template aprovado
// setor_laboratorio_alerta_energia2: cabeçalho, setor, consumo, causas
// prováveis, ação e assinatura. O corpo do template WhatsApp em si (texto
// fixo aprovado na Meta) não é alterado por aqui.
export function formatStandardAlertMessage(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'sectorName' | 'type' | 'val' | 'subName' | 'subVal' | 'subMedian'>
): string {
  const setor = anomaly.sectorName.toUpperCase();
  const causas = getPossibleCauses(anomaly);
  const acao = getActionText(anomaly);
  return [
    `⚠️ ALERTA - ${setor}`,
    `Consumo anômalo de energia detectado!`,
    ``,
    `Setor: ${setor}`,
    `Consumo: ${kwhFormatter.format(anomaly.val)} kWh (últimos 15 min)`,
    ``,
    `Possíveis causas:`,
    ...causas.map(c => `- ${c}`),
    ``,
    `Ação: ${acao}`,
    `Equipe Carbono Zero`,
  ].join('\n');
}

// Texto de diagnóstico simples (sem tendência histórica) para o alerta
// automático disparado em background, sem interação do usuário.
export function getDiagnosticText(anomaly: SectorAnomaly): string {
  return `Identificado pico crítico de consumo. O setor está operando com ${kwhFormatter.format(anomaly.val)} kWh no intervalo de 15 minutos, ${kwhFormatter.format(anomaly.deviation)}% acima do limite esperado de ${kwhFormatter.format(anomaly.expectedMax)} kWh.`;
}

// Avalia os setores conhecidos (SECTOR_MAPPING) em uma única linha de
// telemetria contra as estatísticas históricas do turno correspondente.
// Usado tanto para varrer várias linhas (histórico) quanto uma só (snapshot
// mais recente).
export function detectSectorAnomalies(
  row: ProcessedTelemetryData,
  sStats: Record<string, Record<TimeBand, SectorStats>>
): SectorAnomaly[] {
  const band = getBand(row.hour);
  const dateStr = row.timestamp.split(/[T ]/)[0];
  const anomalies: SectorAnomaly[] = [];

  Object.keys(SECTOR_MAPPING).forEach(sec => {
    const actualKey = ALL_SECTORS.find(k => k.includes(sec)) || sec;
    const val = Number(row[actualKey]);
    const s = sStats[actualKey]?.[band];

    if (!s || s.mean === 0) return;

    const upperLimit = s.mean + (1.5 * s.stdDev);

    if (val > upperLimit && val > 5) {
      const deviation = ((val - upperLimit) / upperLimit) * 100;
      if (deviation > 10) {
        let severity: SectorAnomaly['severity'] = 'Moderado';
        if (deviation > 50) severity = 'Crítico';
        else if (deviation > 20) severity = 'Alto';

        const mapInfo = SECTOR_MAPPING[sec];
        let subVal = 0;
        let subMedian = 1;
        let actualSubKey = '';

        if (mapInfo.sub) {
          actualSubKey = ALL_SECTORS.find(k => k.includes(mapInfo.sub!)) || mapInfo.sub;
          subVal = Number(row[actualSubKey]) || 0;
          subMedian = sStats[actualSubKey]?.[band]?.median || 1;
        }

        anomalies.push({
          date: dateStr,
          time: row.time,
          band,
          sectorName: mapInfo.label,
          sectorKey: actualKey,
          type: mapInfo.type,
          val,
          mean: s.mean,
          expectedMax: upperLimit,
          deviation,
          severity,
          subVal,
          subMedian,
          subName: actualSubKey,
          templateOverride: mapInfo.template,
        });
      }
    }
  });

  return anomalies;
}
