// Estimativa de custo/impacto financeiro das anomalias (Etapa 4 da
// refatoração). Tudo aqui depende de uma tarifa de energia — o preço do kWh
// varia muito por estado/distribuidora/classe no Brasil (de ~R$0,41 a mais
// de R$1,40/kWh, conforme ranking da ANEEL), então não existe um único
// "preço nacional" confiável. `DEFAULT_TARIFF_BRL_PER_KWH` é uma estimativa
// média de mercado pra classe comercial/industrial, usada só enquanto a
// tarifa real do contrato do hospital não é informada.
//
// Ordem de prioridade pra decidir qual tarifa usar: 1) valor salvo na tela
// de Configurações (localStorage, o hospital pode digitar a tarifa real do
// contrato a qualquer momento, sem precisar mexer em código/Vercel);
// 2) env var VITE_TARIFF_BRL_PER_KWH (configurada no Vercel); 3) o
// placeholder abaixo. Toda mensagem que usa esse cálculo deixa explícito
// que é uma estimativa, pra ninguém confundir com uma cobrança real.

export const DEFAULT_TARIFF_BRL_PER_KWH = 0.75;
const TARIFF_STORAGE_KEY = 'tariff_brl_per_kwh';

export function getTariffBRLPerKWh(): number {
  try {
    const fromStorage = localStorage.getItem(TARIFF_STORAGE_KEY);
    const parsedStorage = fromStorage ? Number(String(fromStorage).replace(',', '.')) : NaN;
    if (!isNaN(parsedStorage) && parsedStorage > 0) return parsedStorage;
  } catch {
    // localStorage indisponível (ex: execução no cron server-side, fora do browser) — ignora e cai pro próximo nível
  }

  let fromViteEnv = undefined;
  try {
    fromViteEnv = (import.meta as any)?.env?.VITE_TARIFF_BRL_PER_KWH;
  } catch (e) {
    // Ignore, might be running in Node
  }

  const parsedViteEnv = fromViteEnv ? Number(String(fromViteEnv).replace(',', '.')) : NaN;
  if (!isNaN(parsedViteEnv) && parsedViteEnv > 0) return parsedViteEnv;

  // Fallback pro cron server-side (sem import.meta.env do Vite nesse contexto).
  const fromProcessEnv = typeof process !== 'undefined' && process.env ? process.env.TARIFF_BRL_PER_KWH : undefined;
  const parsedProcessEnv = fromProcessEnv ? Number(String(fromProcessEnv).replace(',', '.')) : NaN;
  return !isNaN(parsedProcessEnv) && parsedProcessEnv > 0 ? parsedProcessEnv : DEFAULT_TARIFF_BRL_PER_KWH;
}

// Duração (em horas) de cada turno usado em anomalyDetection.ts — usada pra
// projetar "se esse padrão persistir todo santo dia durante esse turno,
// quanto custaria por mês". É uma suposição explícita e documentada (não um
// número mágico): assume que a anomalia se repete no MESMO turno em que foi
// detectada, todos os dias do mês. "Demais Horários" cobre os intervalos
// fora dos 3 turnos nomeados (14h "Almoço"→18h "Jantar" e 22h→07h), por isso
// tem mais horas.
export const BAND_DURATION_HOURS: Record<string, number> = {
  'Café da Manhã (07-10h)': 3,
  'Almoço (10-14h)': 4,
  'Jantar (18-22h)': 4,
  'Demais Horários': 13,
};

const INTERVALS_PER_HOUR = 4; // leituras de 15 em 15 minutos

export interface FinancialImpact {
  excedenteKwhIntervalo: number;
  custoEstimadoIntervalo: number;
  bandHours: number;
  projecaoMensalBRL: number;
  tarifaUsada: number;
}

// `val`: consumo medido no intervalo de 15min. `baseline`: valor "normal"
// esperado (a métrica central escolhida automaticamente pela análise
// estatística — ver statistics.ts). `band`: turno em que a anomalia ocorreu,
// usado pra estimar quantas horas/dia esse padrão consome se persistir.
export function calcFinancialImpact(val: number, baseline: number, band: string): FinancialImpact {
  const tarifaUsada = getTariffBRLPerKWh();
  const excedenteKwhIntervalo = Math.max(0, val - baseline);
  const custoEstimadoIntervalo = excedenteKwhIntervalo * tarifaUsada;
  const bandHours = BAND_DURATION_HOURS[band] ?? 4;
  // excedente por intervalo × intervalos/hora × horas/dia × 30 dias × tarifa
  const projecaoMensalBRL = excedenteKwhIntervalo * INTERVALS_PER_HOUR * bandHours * 30 * tarifaUsada;

  return { excedenteKwhIntervalo, custoEstimadoIntervalo, bandHours, projecaoMensalBRL, tarifaUsada };
}

export function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
