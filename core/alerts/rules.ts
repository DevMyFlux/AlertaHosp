// Parâmetros do motor de alertas. Tudo que é "regra de negócio" numérica está
// aqui (e, em produção, na tabela `alert_rules`, versionada). Nenhum limiar
// fica espalhado pelo código.

import type { Severity } from './types.js';

export interface LevelRule {
  /** quantos desvios robustos acima da mediana */
  z: number;
  /** excesso relativo mínimo sobre a mediana (0,35 = +35%) */
  pct: number;
  /** leituras consecutivas acima do limite antes de abrir/escalar */
  persistence: number;
}

export interface RuleSet {
  /** identifica a versão gravada em cada evento (explicabilidade/auditoria) */
  version: string;
  /** histórico usado para o baseline (dias) */
  lookbackDays: number;
  /** amostras mínimas por faixa para confiar no baseline; abaixo disso não alerta */
  minBaselineSamples: number;
  /** piso do desvio: fração da mediana (evita bandas estreitas demais em setores muito estáveis) */
  sigmaRelFloor: number;
  /** piso do desvio em potência média (kW) — vale para qualquer intervalo de amostragem */
  sigmaAbsFloorKw: number;
  /** excesso absoluto mínimo, em potência média (kW), para valer um alerta */
  minExcessKw: number;
  /** "envelope": nada abaixo de quantil × (1+tolerância) do que o setor já fez na faixa vira alerta
   *  — protege setores liga/desliga (chillers, compressores, autoclaves) */
  envelope: { quantile: number; tolerance: number };
  levels: Record<Severity, LevelRule>;
  /** leituras normais consecutivas para dar o alerta como recuperado */
  recoveryReadings: number;
  /** se o setor voltar a violar dentro desse prazo após recuperar, é o MESMO alerta que reabre
   *  (evita "pisca-pisca" de alertas e de mensagens) */
  reopenGraceMinutes: number;
  /** escalonamento por duração: alerta que não se resolve sobe um nível em vez de repetir mensagem */
  escalateAfterMinutes: { atencao: number; alto: number };
}

export interface NotifyPolicy {
  /** menor severidade que gera notificação (as abaixo ficam só no painel) */
  notifyFrom: Severity;
  /** lembrete enquanto o alerta continua aberto (minutos); null = nunca */
  reminderMinutes: Record<Severity, number | null>;
  /** só notifica quando o excesso acumulado do alerta vale a mensagem (kWh); 0 = sem piso.
   *  Cada WhatsApp tem custo — um desvio de R$ 2 não deve gerar uma mensagem. */
  minExcessKwhToNotify: number;
  /** avisar quando um alerta já notificado se recupera */
  notifyOnRecovery: boolean;
  /** teto de mensagens por unidade/hora; o excedente entra no próximo resumo (CRÍTICO nunca é retido) */
  maxPerUnitPerHour: number;
  /** leitura mais velha que isso não dispara notificação (evita avisar sobre dado velho após uma queda) */
  freshnessMinutes: number;
}

export const DEFAULT_RULES: RuleSet = {
  version: 'robust-z/1',
  lookbackDays: 28,
  minBaselineSamples: 24,
  sigmaRelFloor: 0.1,
  sigmaAbsFloorKw: 1,
  minExcessKw: 2,
  envelope: { quantile: 0.99, tolerance: 0.05 },
  levels: {
    atencao: { z: 3, pct: 0.15, persistence: 2 },
    alto: { z: 4.5, pct: 0.3, persistence: 2 },
    critico: { z: 7, pct: 0.5, persistence: 2 },
  },
  recoveryReadings: 3,
  reopenGraceMinutes: 90,
  escalateAfterMinutes: { atencao: 360, alto: 720 },
};

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  notifyFrom: 'alto',
  reminderMinutes: { atencao: null, alto: 360, critico: 180 },
  minExcessKwhToNotify: 10,
  notifyOnRecovery: false,
  maxPerUnitPerHour: 6,
  freshnessMinutes: 45,
};
