import { ProcessedTelemetryData, ALL_SECTORS } from '../types.js';
import { analyzeDistribution, DistributionStats, calcTrendSlope, RepresentativeMetric } from './statistics.js';
import { calcFinancialImpact, formatBRL, BAND_DURATION_HOURS } from './costEstimation.js';
import { getAlertLogSince, LoggedAlert } from './alertLog.js';

export type TimeBand = 'Café da Manhã (07-10h)' | 'Almoço (10-14h)' | 'Jantar (18-22h)' | 'Demais Horários';

export function getBand(hour: number): TimeBand {
  if (hour >= 7 && hour < 10) return 'Café da Manhã (07-10h)';
  if (hour >= 10 && hour < 14) return 'Almoço (10-14h)';
  if (hour >= 18 && hour < 22) return 'Jantar (18-22h)';
  return 'Demais Horários';
}

// Nome (sem namespace) do template único usado por TODOS os setores. Até a
// rodada anterior existiam 4 templates separados (um por `type`, corpo fixo
// por tipo). Trocado por um único template com 9 variáveis a pedido do
// cliente: mais fácil de aprovar na Meta (um cadastro só), reaproveitável
// pra qualquer setor novo sem precisar de outro template aprovado, e a
// causa/ação passam a ser parâmetros (entram como texto, não fazem parte do
// corpo fixo) — o que deixa o template pronto pra uma futura IA de análise
// simplesmente enviar um texto diferente em {{8}}/{{9}} sem precisar subir
// um template novo pra cada padrão detectado.
//
// IMPORTANTE (lição aprendida cadastrando os templates anteriores): a Meta
// rejeita (com erro genérico "modelo tem erros") um template que usa a
// mesma variável {{n}} mais de uma vez no corpo. Cada uma das 9 variáveis
// abaixo aparece exatamente uma vez no corpo aprovado. Chegou a ter 11
// variáveis numa versão anterior (impacto anual + economia potencial
// separados do impacto mensal); simplificado porque as duas só repetiam o
// mesmo valor sem informação nova.
export const UNIFIED_TEMPLATE_NAME = 'alerta_consumo_inteligente_v1';

// `template`: nome do WhatsApp Message Template usado pra esse setor — hoje
// sempre UNIFIED_TEMPLATE_NAME, mas mantido como campo por setor (em vez de
// uma constante solta no código que chama) pra permitir voltar a diferenciar
// por setor/tipo no futuro sem mexer em quem consome SECTOR_MAPPING. Se o
// envio pro template falhar por qualquer motivo (ex: ainda em análise na
// Meta), o backend cai automaticamente pro "sistema_de_alerta" antes de
// desistir pro SMS (ver api/app.ts) — então falta de aprovação não interrompe
// o envio, só faz o alerta sair no formato antigo até ser aprovado.
export const SECTOR_MAPPING: Record<string, { label: string; sub?: string; type: string; template?: string }> = {
  'DJ1_Lavanderia': { label: 'Lavanderia', sub: 'ME_CLIM_LAVANDERIA', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'DJ7_Oncologia': { label: 'Oncologia', sub: 'ME_CLIM_ONC_A_T', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'DJ13_Laboratorio': { label: 'Laboratório', sub: 'ME_CLIM_LABORATORIO', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'DJ40_Refeitorio': { label: 'Refeitório', sub: 'ME_CLIM_REF', type: 'Infra', template: UNIFIED_TEMPLATE_NAME },
  'DJ50_CME': { label: 'CME', sub: 'ME_CLIM_CC_CO_CME', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'SADT': { label: 'SADT', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_UTI_QG_E3': { label: 'UTI QG', sub: 'ME_CLIM_UTI', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'ME_UTI_QD_IT': { label: 'UTI QD IT', sub: 'ME_CLIM_UTI', type: 'Crítico', template: UNIFIED_TEMPLATE_NAME },
  'DJ14_Radiologia': { label: 'Radiologia', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'DJ60_RM': { label: 'Ressonância', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'DJ61_Tomografia': { label: 'Tomografia', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'DJ58_RX1': { label: 'Raios-X 1', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  'DJ59_RX2': { label: 'Raios-X 2', type: 'Imagem', template: UNIFIED_TEMPLATE_NAME },
  // Submetição de climatização promovida a setor próprio de alerta — os
  // dados já vêm na planilha (usados até aqui só como referência cruzada
  // via `sub`), mas nunca foram avaliados como anomalia independente.
  'ME_CLIM_ONC_A_T': { label: 'HVAC Oncologia', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_REF': { label: 'HVAC Refeitório', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_LAVANDERIA': { label: 'HVAC Lavanderia', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_UTI': { label: 'HVAC UTI', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_CC_CO_CME': { label: 'HVAC CME', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_EMERGENCIA': { label: 'HVAC Emergência', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_AMBULATORIO': { label: 'HVAC Ambulatório', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
  'ME_CLIM_LABORATORIO': { label: 'HVAC Laboratório', type: 'HVAC', template: UNIFIED_TEMPLATE_NAME },
};

// Estatística por setor/turno — desde a Etapa 2 da refatoração, isso é só um
// alias pro pacote completo de src/lib/statistics.ts (média, mediana, moda,
// desvio-padrão, MAD, assimetria, métrica auto-selecionada etc). Mantido com
// esse nome pra não quebrar quem importava `SectorStats` daqui.
export type SectorStats = DistributionStats;

// Mantida por compatibilidade — agora delega pro motor estatístico único
// (statistics.ts). Antes calculava só média/mediana/desvio aqui mesmo, uma
// de três implementações duplicadas no sistema (as outras eram
// ActiveAnomalies.tsx e ImagingView.tsx, ambas também migradas).
export function calcStats(vals: number[]): SectorStats {
  return analyzeDistribution(vals);
}

// Amostras mínimas por setor+turno pra confiar na estatística. Com menos que
// isso, média/mediana/moda ficam instáveis demais pra servir de base de
// comparação — o setor simplesmente não gera anomalia até acumular histórico
// suficiente (evita falso positivo por dado escasso, não por comportamento
// realmente anômalo).
const MIN_SAMPLES = 4;

// Janela de base pro cálculo de média/mediana/moda: sempre os últimos 1000
// registros de cada setor+turno, nunca o histórico inteiro. Com leituras de
// 15 em 15 minutos, 1000 registros de um mesmo turno cobrem várias semanas —
// bastante pra estatística ser confiável, sem carregar histórico antigo
// demais (comportamento de consumo muda com o tempo: reforma, novo
// equipamento, mudança de uso do setor etc). Pedido explícito do cliente.
const BASELINE_WINDOW = 1000;

// Constrói a estatística completa (Etapa 2) por setor e turno (janela de
// horário), usando sempre os últimos BASELINE_WINDOW registros de cada
// grupo — a mesma base usada tanto pela análise pontual (LiveMonitorView)
// quanto pelo relatório histórico (DiagnosticsView) e pela Visão Executiva
// (ActiveAnomalies.tsx), evitando que as telas divirjam nos critérios de
// anomalia. `data` deve vir ordenado do mais antigo pro mais recente (mesmo
// formato que processCumulativeData já produz) — assim, cortar os últimos
// BASELINE_WINDOW de cada grupo pega sempre os mais recentes.
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
      const ultimosMil = histData[sec][band].slice(-BASELINE_WINDOW);
      sStats[sec][band] = analyzeDistribution(ultimosMil);
    });
  });

  return sStats;
}

// Margem de alerta (%): quanto o valor novo precisa passar do padrão
// esperado (média/mediana/moda) pra virar alerta. Configurável na tela de
// Configurações (fica salva no navegador); 20% é o padrão até o usuário
// ajustar. Regra simples de propósito — "alerta se passar a média em X%" —
// pra ser fácil de explicar pra quem não é da área técnica.
const DEFAULT_ALERT_MARGIN_PCT = 20;
const MARGIN_STORAGE_KEY = 'alert_margin_pct';

export function getAlertMarginPct(): number {
  try {
    const saved = localStorage.getItem(MARGIN_STORAGE_KEY);
    const parsed = saved ? Number(String(saved).replace(',', '.')) : NaN;
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch {
    // localStorage indisponível (ex: execução no cron server-side, fora do
    // navegador) — cai pra env var, depois pro padrão.
  }
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env.ALERT_MARGIN_PCT : undefined;
  const parsedEnv = fromEnv ? Number(String(fromEnv).replace(',', '.')) : NaN;
  if (!isNaN(parsedEnv) && parsedEnv > 0) return parsedEnv;
  return DEFAULT_ALERT_MARGIN_PCT;
}

export interface SectorAnomaly {
  // Campos originais — mantidos com o mesmo nome/tipo pra não quebrar
  // LiveMonitorView, DiagnosticsView, ActiveAnomalies, alertLog etc.
  date: string;
  time: string;
  band: TimeBand;
  sectorName: string;
  sectorKey: string;
  type: string;
  val: number;
  /** Média aritmética histórica do setor/turno (sempre a média "clássica",
   *  independente da métrica auto-selecionada). Exibida como "MÉDIA
   *  HISTÓRICA" no Monitoramento 15m. */
  mean: number;
  /** Limiar de disparo: padrão esperado (centralValue) × (1 + margem de
   *  erro configurável em Configurações, padrão 20%). Exibido como "LIMITE
   *  DISPARO" / "Lim. Estatístico". */
  expectedMax: number;
  /** % que o consumo está acima do PADRÃO ESPERADO (centralValue) — não do
   *  limiar de disparo. Antes da Etapa 2 esse campo media a distância até o
   *  limiar (upperLimit), o que não batia com o texto exibido nas telas
   *  ("desvio em relação à média esperada"); agora mede exatamente isso. */
  deviation: number;
  severity: 'Moderado' | 'Alto' | 'Crítico';
  subVal: number;
  subMedian: number;
  subName: string;
  // Nome (sem namespace) de um template específico pra esse setor, se
  // configurado em SECTOR_MAPPING. Ausente = usa o "sistema_de_alerta".
  templateOverride?: string;

  // --- Campos novos (Etapa 2/4/5 da refatoração) ---
  /** Métrica auto-selecionada como mais representativa do comportamento
   *  normal desse setor/turno: 'mean' (distribuição simétrica), 'median'
   *  (muitos outliers/assimetria) ou 'mode' (comportamento repetitivo). */
  representativeMetric: RepresentativeMetric;
  /** Valor da métrica escolhida — o "padrão esperado" usado em todos os
   *  cálculos de excedente/custo/percentual. */
  centralValue: number;
  /** true se a anomalia também é confirmada usando a média aritmética pura
   *  como padrão esperado (em vez da métrica auto-selecionada), com a
   *  mesma margem %. Cross-validação pedida na Etapa 2 pra aumentar a
   *  confiabilidade — não suprime a anomalia quando as métricas discordam,
   *  só sinaliza. */
  crossValidated: boolean;
  /** Consumo excedente estimado no intervalo de 15 min (kWh). */
  excedenteKwh: number;
  /** Custo estimado do excesso apenas neste intervalo (R$). */
  custoEstimadoBRL: number;
  /** Projeção financeira mensal (R$) caso esse padrão se repita todo dia
   *  durante o mesmo turno em que foi detectado. */
  projecaoMensalBRL: number;
  /** Tarifa (R$/kWh) usada nos cálculos acima — ver src/lib/costEstimation.ts
   *  (hoje é um valor de mercado genérico, não a tarifa real do contrato). */
  tarifaUsadaBRL: number;
  /** Quantas vezes esse mesmo setor+turno já gerou alerta nos últimos 30
   *  dias (via src/lib/alertLog.ts). */
  frequenciaHistorica: number;
  /** Tendência recente do setor (regressão linear normalizada sobre as
   *  últimas leituras): positiva = subindo, negativa = caindo, perto de
   *  zero = estável. Ver ressalva sobre janela curta de dados no resumo da
   *  refatoração. */
  trendSlope: number;
}

const kwhFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const pctFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

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

// Parâmetros {{1}}/{{2}} dos templates alerta_*_energia (nome do setor,
// valor). Confirmado nas "Amostras de variáveis" do template aprovado:
// {{1}} = "LABORATÓRIO" (setor em maiúsculo, sem unidade) e {{2}} = "125.45"
// (só o número, SEM "kWh" — a unidade já está fixa no corpo do template,
// logo depois da variável). Antes essa função grudava " kWh" no {{2}},
// duplicando a unidade na mensagem final ("125,4 kWh kWh").
export function formatSetorNomeParam(sectorName: string): string {
  return sectorName.toUpperCase();
}

export function formatValorComUnidadeParam(val: number, _unidade: string = 'kWh'): string {
  return kwhFormatter.format(val);
}

// Parâmetros {{1}}..{{9}} do template WhatsApp único (UNIFIED_TEMPLATE_NAME).
// Cada função aqui embaixo cobre exatamente uma variável, na ordem do corpo
// aprovado na Meta:
//   {{1}}  dia da semana + data/hora        {{6}}  impacto financeiro mensal
//   {{2}}  setor                            {{7}}  ocorrências semelhantes (30 dias)
//   {{3}}  percentual acima do esperado     {{8}}  causa provável
//   {{4}}  consumo excedente (kWh)          {{9}}  ação recomendada
//   {{5}}  custo estimado do evento
//
// Existiam também {{7}} "impacto anual" e {{8}} "economia potencial" numa
// versão anterior de 11 variáveis — removidas por pedido do cliente: ambas
// só repetiam o valor de "impacto mensal" (uma ×12, a outra reformulada
// como economia), sem trazer informação nova, e deixavam o template mais
// longo pra revisar/aprovar na Meta à toa.
// {{1}} dia da semana + data/hora (ex: "segunda-feira, 14/07 às 05:38")
export function formatDataHoraParam(anomaly: Pick<SectorAnomaly, 'date' | 'time'>): string {
  const weekday = getWeekdayPt(anomaly.date);
  const [ano, mes, dia] = anomaly.date.split('-');
  const dataFmt = (!ano || !mes || !dia) ? anomaly.date : `${dia}/${mes}`;
  return `${weekday}, ${dataFmt} às ${anomaly.time}`;
}

// {{3}} percentual acima do padrão esperado (ex: "31%").
export function formatPercentualParam(anomaly: Pick<SectorAnomaly, 'deviation'>): string {
  return `${pctFormatter.format(anomaly.deviation)}%`;
}

// {{4}} consumo excedente no intervalo, em kWh (ex: "2,1 kWh").
export function formatExcedenteKwhParam(anomaly: Pick<SectorAnomaly, 'excedenteKwh'>): string {
  return `${kwhFormatter.format(anomaly.excedenteKwh)} kWh`;
}

// {{5}} custo estimado apenas deste evento/intervalo (ex: "R$ 3,82").
export function formatCustoEventoParam(anomaly: Pick<SectorAnomaly, 'custoEstimadoBRL'>): string {
  return formatBRL(anomaly.custoEstimadoBRL);
}

// {{6}} impacto financeiro projetado por mês, caso o padrão se repita todo
// dia durante o mesmo turno em que foi detectado (ex: "R$ 1.240,00").
export function formatImpactoMensalValorParam(anomaly: Pick<SectorAnomaly, 'projecaoMensalBRL'>): string {
  return formatBRL(anomaly.projecaoMensalBRL);
}

// {{7}} quantas vezes esse padrão já ocorreu nos últimos 30 dias (ex: "3
// vezes nos últimos 30 dias"). Frase pronta pra encaixar em "já ocorreu
// {{7}}." Vem do histórico local de alertas (src/lib/alertLog.ts,
// localStorage do navegador) — só conta ocorrências que esse mesmo
// navegador já detectou e registrou, não o histórico completo da planilha.
// Zera se o localStorage for limpo ou se o alerta for aberto de outro
// navegador/dispositivo. Fica preciso quando o envio automático rodar
// 100% no servidor (item pendente da lista de tarefas).
export function formatOcorrenciasParam(anomaly: Pick<SectorAnomaly, 'frequenciaHistorica'>): string {
  const n = anomaly.frequenciaHistorica;
  if (n <= 0) return 'sem registro de ocorrência semelhante nos últimos 30 dias';
  return `${n} ${n === 1 ? 'vez' : 'vezes'} nos últimos 30 dias`;
}

// {{8}} causa provável — frase curta por setor/tipo, ver getCauseProfile.
export function formatCausaProvavelParam(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'type' | 'subName' | 'subVal' | 'subMedian'>
): string {
  return getCauseProfile(anomaly).causaTemplateWA;
}

// {{9}} ação recomendada — complemento nominal que encaixa em "verificar
// {{9}}.", ver getCauseProfile.
export function formatAcaoRecomendadaParam(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'type' | 'subName' | 'subVal' | 'subMedian'>
): string {
  return getCauseProfile(anomaly).acaoTemplateWA;
}

// Mesmo cabeçalho usado no card do Relatório de Diagnóstico da IA. Não usado
// em nenhuma outra parte do sistema hoje (candidato a remoção futura, mas
// mantido por ora — Etapa 1 pede documentar código morto, não apagar sem
// justificativa).
export function formatAlertHeader(sectorName: string): string {
  return `🚨 ALERTA DE ANOMALIA - ${sectorName.toUpperCase()}`;
}

// Diagnóstico de causa/ação por setor ou tipo, em linguagem técnica mas
// direta — sem jargão de marca/equipamento (ex: "Chiller"), trocado por
// termos que qualquer pessoa da equipe entende ("sistema de refrigeração do
// equipamento"). `contexto`/`causaProvavel`/`acao` alimentam a mensagem
// completa (SMS/interna, formatStandardAlertMessage — frases longas).
// `causaTemplateWA`/`acaoTemplateWA` alimentam {{8}}/{{9}} do template
// WhatsApp único (UNIFIED_TEMPLATE_NAME) — frases curtas, sem "Recomenda-se
// verificar" (isso já está fixo no corpo do template, em "✅ Ação
// recomendada: verificar {{9}}.").
interface CauseProfile {
  contexto: string;
  causaProvavel: string;
  acao: string;
  /** Frase curta pra {{8}} do template WhatsApp (ex: "sistema de
   *  climatização operando acima da carga térmica habitual"). */
  causaTemplateWA: string;
  /** Complemento nominal pra {{9}}, encaixa em "verificar {{9}}." (ex:
   *  "filtros, compressores, setpoint e funcionamento da climatização"). */
  acaoTemplateWA: string;
}

// Perfis específicos por setor — sobrepõem o perfil genérico do `type`
// quando o setor tem uma causa característica conhecida (ex: CME e
// autoclaves). Chave = sectorKey (mesma chave usada em SECTOR_MAPPING).
const SECTOR_SPECIFIC_PROFILES: Record<string, CauseProfile> = {
  'DJ50_CME': {
    contexto: 'uso simultâneo de autoclaves e climatização fora da curva',
    causaProvavel: 'carga térmica elevada ou equipamento de processo operando fora do comportamento habitual',
    acao: 'Recomenda-se verificar a climatização local e os equipamentos de apoio (autoclaves).',
    causaTemplateWA: 'uso simultâneo de autoclaves e climatização fora do perfil habitual',
    acaoTemplateWA: 'a climatização local, as autoclaves e os equipamentos de apoio',
  },
  'DJ13_Laboratorio': {
    contexto: 'uso simultâneo de equipamentos de análise e refrigeração',
    causaProvavel: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    acao: 'Recomenda-se verificar os equipamentos de análise em uso e o funcionamento dos refrigeradores/freezers do setor.',
    causaTemplateWA: 'equipamentos de análise em operação contínua ou falha em refrigerador/freezer',
    acaoTemplateWA: 'os equipamentos de análise em uso e os refrigeradores/freezers do setor',
  },
};

const TYPE_PROFILES: Record<string, CauseProfile> = {
  'Crítico': {
    contexto: 'uso simultâneo de equipamentos de suporte à vida acima do padrão habitual',
    causaProvavel: 'carga elevada de equipamentos essenciais ou pico de demanda simultânea',
    acao: 'Recomenda-se confirmar com a enfermaria ou supervisão do setor o uso extraordinário de equipamentos. Evitar desligamentos sem validação clínica.',
    causaTemplateWA: 'uso simultâneo de equipamentos de suporte à vida acima do padrão habitual',
    acaoTemplateWA: 'os equipamentos essenciais em uso junto à enfermaria ou supervisão do setor',
  },
  'Imagem': {
    contexto: 'exames de alta demanda em sequência ou sobrecarga do sistema de refrigeração do equipamento',
    causaProvavel: 'carga térmica do equipamento ou exame de longa duração fora do padrão',
    acao: 'Recomenda-se verificar o sistema de refrigeração do equipamento e a agenda de exames do período.',
    causaTemplateWA: 'exames de alta demanda em sequência ou sobrecarga térmica dos equipamentos',
    acaoTemplateWA: 'a agenda de exames, o sistema de refrigeração e os equipamentos de diagnóstico',
  },
  'HVAC': {
    contexto: 'climatização operando fora da curva normal',
    causaProvavel: 'carga térmica elevada ou equipamento de climatização fora do padrão de funcionamento',
    acao: 'Recomenda-se verificar filtros, compressor e o ajuste do termostato do sistema de climatização.',
    causaTemplateWA: 'sistema de climatização operando acima da carga térmica habitual',
    acaoTemplateWA: 'os filtros, compressores, setpoint e funcionamento da climatização',
  },
  'Infra': {
    contexto: 'uso de equipamentos ou iluminação fora do horário habitual',
    causaProvavel: 'equipamento ou iluminação em operação fora do horário previsto',
    acao: 'Recomenda-se verificar equipamentos e iluminação do setor.',
    causaTemplateWA: 'equipamentos ou iluminação operando fora do horário previsto',
    acaoTemplateWA: 'a iluminação, os equipamentos auxiliares e as cargas não essenciais',
  },
};

export function getCauseProfile(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'type' | 'subName' | 'subVal' | 'subMedian'>
): CauseProfile {
  const specific = SECTOR_SPECIFIC_PROFILES[anomaly.sectorKey];
  if (specific) return specific;

  const base = TYPE_PROFILES[anomaly.type] || TYPE_PROFILES['Infra'];

  // Climatização puxando a carga num setor sem perfil específico próprio:
  // reaproveita a causa provável do tipo, mas troca o contexto/ação pra
  // apontar direto pra climatização (mesmo texto pedido pelo cliente).
  if (anomaly.subName && anomaly.subVal > anomaly.subMedian * 1.3) {
    return {
      contexto: 'climatização operando fora da curva normal',
      causaProvavel: base.causaProvavel,
      acao: 'Recomenda-se verificar climatização local e equipamentos de apoio.',
      causaTemplateWA: 'climatização operando fora da curva normal',
      acaoTemplateWA: 'a climatização local e os equipamentos de apoio',
    };
  }

  return base;
}

// Ação de campo recomendada com base no setor/tipo (mesma classificação
// usada no Monitoramento de 15 Minutos e no Relatório de Diagnóstico da IA).
export function getActionText(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'type' | 'subName' | 'subVal' | 'subMedian'>
): string {
  return getCauseProfile(anomaly).acao;
}

// Nome do dia da semana em português a partir de uma data "YYYY-MM-DD" —
// usado na frase de abertura da mensagem (Etapa 4: "...para segunda-feira
// às 05:38"). Meio-dia fixo evita problemas de fuso na conversão.
function getWeekdayPt(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('pt-BR', { weekday: 'long' });
  } catch {
    return dateStr;
  }
}

// Corpo da mensagem efetivamente recebida pelo destinatário via SMS de
// fallback (quando o template WhatsApp falha) e também usado como registro
// interno do alerta. Reescrito no formato pedido pelo cliente: 3 parágrafos
// corridos (sem lista de tópicos), linguagem técnica mas direta, sem jargão
// de equipamento. O corpo dos templates WhatsApp em si (texto fixo aprovado
// na Meta) não é alterado por aqui — só os parâmetros {{n}} enviados a eles.
export function formatStandardAlertMessage(anomaly: SectorAnomaly): string {
  const setor = anomaly.sectorName.toUpperCase();
  const perfil = getCauseProfile(anomaly);
  const weekday = getWeekdayPt(anomaly.date);
  const horasTurno = BAND_DURATION_HOURS[anomaly.band] ?? 4;

  const paragrafo1 = anomaly.frequenciaHistorica > 0
    ? `O consumo do ${setor} está ${pctFormatter.format(anomaly.deviation)}% acima do padrão esperado para ${weekday} às ${anomaly.time}. Este padrão já ocorreu ${anomaly.frequenciaHistorica} ${anomaly.frequenciaHistorica === 1 ? 'vez' : 'vezes'} nos últimos 30 dias, normalmente associado a ${perfil.contexto}.`
    : `O consumo do ${setor} está ${pctFormatter.format(anomaly.deviation)}% acima do padrão esperado para ${weekday} às ${anomaly.time}. Não há registro de ocorrências semelhantes nos últimos 30 dias — pode ser um evento pontual ou o início de um novo padrão.`;

  const paragrafo2 = `Causa provável: ${perfil.causaProvavel}. ${perfil.acao}`;

  const paragrafo3 = `Consumo excedente estimado: ${kwhFormatter.format(anomaly.excedenteKwh)} kWh no intervalo. Se o padrão persistir por ${horasTurno}h/dia, impacto projetado: ${formatBRL(anomaly.projecaoMensalBRL)}/mês.`;

  return [
    `⚠️ ALERTA - ${setor}`,
    ``,
    paragrafo1,
    ``,
    paragrafo2,
    ``,
    paragrafo3,
    ``,
    `Equipe Carbono Zero`,
  ].join('\n');
}

// Texto de diagnóstico simples (sem tendência histórica), não usado em
// nenhuma tela hoje — candidato a remoção futura (ver nota em
// formatAlertHeader). Mantido funcional e coerente com os novos campos.
export function getDiagnosticText(anomaly: SectorAnomaly): string {
  return `Identificado pico crítico de consumo. O setor está operando com ${kwhFormatter.format(anomaly.val)} kWh no intervalo de 15 minutos, ${pctFormatter.format(anomaly.deviation)}% acima do padrão esperado de ${kwhFormatter.format(anomaly.centralValue)} kWh.`;
}

// Abaixo disso (kWh) não vale a pena alertar mesmo que ultrapasse a margem
// — ruído de setores com consumo residual muito baixo.
const ABS_FLOOR_KWH = 5;
// Janela de leituras recentes usada pra estimar tendência (Etapa 5) — 8
// leituras de 15 min = 2h.
const TREND_WINDOW = 8;
// Janela de tempo considerada "histórico recente" pra frequência de
// ocorrência (Etapa 4).
const FREQUENCY_WINDOW_HOURS = 30 * 24;

// Avalia os setores conhecidos (SECTOR_MAPPING) em uma única linha de
// telemetria contra as estatísticas históricas do turno correspondente.
// Usado tanto para varrer várias linhas (histórico) quanto uma só (snapshot
// mais recente). `recentData`, se informado, habilita o cálculo de
// tendência (Etapa 5) usando as últimas leituras de cada setor.
export function detectSectorAnomalies(
  row: ProcessedTelemetryData,
  sStats: Record<string, Record<TimeBand, SectorStats>>,
  recentData?: ProcessedTelemetryData[],
  // Permite injetar o histórico de alertas já carregado (ex: pelo cron
  // server-side, que busca do Redis de forma assíncrona antes de chamar
  // esta função síncrona) em vez de ler de getAlertLogSince/localStorage —
  // que no servidor não existe e sempre voltaria vazio.
  recentAlertsOverride?: LoggedAlert[]
): SectorAnomaly[] {
  const band = getBand(row.hour);
  const dateStr = row.timestamp.split(/[T ]/)[0];
  const anomalies: SectorAnomaly[] = [];
  // Lido uma vez por chamada (não por setor) — custo desprezível, evita 20+
  // leituras de localStorage na mesma varredura.
  const recentAlerts = recentAlertsOverride ?? getAlertLogSince(FREQUENCY_WINDOW_HOURS);
  const marginPct = getAlertMarginPct();
  const marginMultiplier = 1 + marginPct / 100;

  Object.keys(SECTOR_MAPPING).forEach(sec => {
    const actualKey = ALL_SECTORS.find(k => k.includes(sec)) || sec;
    const val = Number(row[actualKey]);
    const s = sStats[actualKey]?.[band];

    if (!s || s.count < MIN_SAMPLES || s.centralValue <= 0) return;
    if (isNaN(val) || val <= ABS_FLOOR_KWH) return;

    // Limiar de disparo: padrão esperado (métrica auto-selecionada, Etapa 2)
    // + margem de erro em % (configurável em Configurações, padrão 20%).
    // Regra simples de propósito, fácil de explicar: "alerta se o consumo
    // passar o padrão esperado em X%".
    const upperLimit = s.centralValue * marginMultiplier;
    if (val <= upperLimit) return;

    // % acima do padrão esperado — é o número mostrado nas telas e nas
    // mensagens de alerta (Etapa 4). Como o disparo já exige ultrapassar a
    // margem, esse valor é sempre >= marginPct quando a anomalia dispara.
    const percentualAcimaEsperado = ((val - s.centralValue) / s.centralValue) * 100;

    let severity: SectorAnomaly['severity'] = 'Moderado';
    if (percentualAcimaEsperado > 70) severity = 'Crítico';
    else if (percentualAcimaEsperado > 30) severity = 'Alto';

    // Validação cruzada (Etapa 2: "sempre que possível, utilizar mais de
    // uma métrica"): confirma a anomalia também pela média aritmética
    // "pura" (não a métrica auto-selecionada), usando a mesma margem %.
    // Não suprime a anomalia quando as métricas discordam — só marca como
    // não cross-validada, pra não esconder eventos reais atrás de um
    // segundo critério mais conservador.
    const classicUpperLimit = s.mean * marginMultiplier;
    const crossValidated = val > classicUpperLimit;

    const mapInfo = SECTOR_MAPPING[sec];
    let subVal = 0;
    let subMedian = 1;
    let actualSubKey = '';
    if (mapInfo.sub) {
      actualSubKey = ALL_SECTORS.find(k => k.includes(mapInfo.sub!)) || mapInfo.sub;
      subVal = Number(row[actualSubKey]) || 0;
      subMedian = sStats[actualSubKey]?.[band]?.median || 1;
    }

    const financial = calcFinancialImpact(val, s.centralValue, band);

    let trendSlope = 0;
    if (recentData && recentData.length > 1) {
      const series = recentData
        .slice(-TREND_WINDOW)
        .map(r => Number(r[actualKey]))
        .filter(v => !isNaN(v) && v > 0);
      trendSlope = calcTrendSlope(series);
    }

    const frequenciaHistorica = recentAlerts.filter(
      a => a.sectorKey === actualKey && a.band === band
    ).length;

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
      deviation: percentualAcimaEsperado,
      severity,
      subVal,
      subMedian,
      subName: actualSubKey,
      templateOverride: mapInfo.template,
      representativeMetric: s.recommendedMetric,
      centralValue: s.centralValue,
      crossValidated,
      excedenteKwh: financial.excedenteKwhIntervalo,
      custoEstimadoBRL: financial.custoEstimadoIntervalo,
      projecaoMensalBRL: financial.projecaoMensalBRL,
      tarifaUsadaBRL: financial.tarifaUsada,
      frequenciaHistorica,
      trendSlope,
    });
  });

  return anomalies;
}
