// Política de notificação: transforma o que aconteceu no ciclo em "enviar ou
// não enviar" — cooldown/lembrete, escalonamento, taxa máxima e agrupamento.
//
// O objetivo é reduzir custo SEM esconder problema real:
//  • severidades abaixo de `notifyFrom` ficam só no painel;
//  • um alerta aberto notifica uma vez; depois só lembra a cada N minutos
//    (por severidade) ou quando ESCALA (severidade maior que a já avisada);
//  • todos os setores que precisam de aviso no mesmo ciclo/unidade saem em UMA
//    mensagem (resumo), não em N;
//  • teto por hora por unidade — mas CRÍTICO nunca é retido;
//  • dado velho (queda de fonte) não gera aviso.

import type { LifecycleEvent, OpenAlertState } from './lifecycle.js';
import type { NotifyPolicy } from './rules.js';
import { LEVEL_RANK, type Severity } from './types.js';

export type NotifyReason = 'opened' | 'escalated' | 'reminder' | 'recovered';

export interface NotifyCandidate {
  sectorCode: string;
  reason: NotifyReason;
  severity: Severity;
  alert: OpenAlertState;
  /** consumo/excesso da leitura que motivou o aviso (para ordenar o resumo) */
  excessKwh: number;
}

export interface CycleSectorOutcome {
  sectorCode: string;
  /** eventos do ciclo para este setor, em ordem */
  events: LifecycleEvent[];
  /** estado ao fim do ciclo (alerta aberto, se houver) */
  open: OpenAlertState | null;
  /** alerta que existia antes de fechar neste ciclo (para aviso de recuperação) */
  closedAlert: OpenAlertState | null;
  /** excesso da última leitura do ciclo */
  lastExcessKwh: number;
}

function reachesThreshold(sev: Severity, from: Severity): boolean {
  return LEVEL_RANK[sev] >= LEVEL_RANK[from];
}

/**
 * Decide quais setores precisam de aviso neste ciclo. Não envia nada nem
 * altera estado — o orquestrador grava `lastNotifiedAt/Severity` depois do envio.
 */
export function collectCandidates(
  outcomes: readonly CycleSectorOutcome[],
  policy: NotifyPolicy,
  now: Date,
  latestReadingTs: Date
): NotifyCandidate[] {
  // dado velho nunca dispara aviso
  const ageMin = (now.getTime() - latestReadingTs.getTime()) / 60000;
  if (ageMin > policy.freshnessMinutes) return [];

  const out: NotifyCandidate[] = [];
  for (const o of outcomes) {
    const open = o.open;

    if (open && reachesThreshold(open.severity, policy.notifyFrom)) {
      const changedNow = o.events.some(e => e.type === 'opened' || e.type === 'reopened' || e.type === 'escalated');
      const alreadyNotifiedAtThisLevel =
        open.lastNotifiedSeverity !== null && LEVEL_RANK[open.lastNotifiedSeverity] >= LEVEL_RANK[open.severity];

      const worthIt = open.totalExcessKwh >= policy.minExcessKwhToNotify;
      if (!alreadyNotifiedAtThisLevel && worthIt && (changedNow || open.lastNotifiedAt === null)) {
        const reason: NotifyReason = open.lastNotifiedAt === null ? 'opened' : 'escalated';
        out.push({ sectorCode: o.sectorCode, reason, severity: open.severity, alert: open, excessKwh: o.lastExcessKwh });
        continue;
      }

      const every = policy.reminderMinutes[open.severity];
      if (every !== null && open.lastNotifiedAt) {
        const sinceMin = (now.getTime() - open.lastNotifiedAt.getTime()) / 60000;
        if (sinceMin >= every) {
          out.push({ sectorCode: o.sectorCode, reason: 'reminder', severity: open.severity, alert: open, excessKwh: o.lastExcessKwh });
        }
      }
    }

    if (policy.notifyOnRecovery && o.closedAlert && o.closedAlert.lastNotifiedAt) {
      out.push({
        sectorCode: o.sectorCode,
        reason: 'recovered',
        severity: o.closedAlert.peakSeverity,
        alert: o.closedAlert,
        excessKwh: 0,
      });
    }
  }
  return out;
}

export interface NotificationPlan {
  /** candidatos cobertos por UMA mensagem (o primeiro é o principal) */
  send: NotifyCandidate[];
  /** candidatos adiados por limite de taxa — reaparecem no próximo ciclo */
  deferred: NotifyCandidate[];
  /** motivo, quando nada é enviado */
  reason: 'nothing_to_send' | 'rate_limited' | null;
}

const ORDER: Record<NotifyReason, number> = { escalated: 0, opened: 1, reminder: 2, recovered: 3 };

function byImportance(a: NotifyCandidate, b: NotifyCandidate): number {
  return (
    LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity] ||
    ORDER[a.reason] - ORDER[b.reason] ||
    b.excessKwh - a.excessKwh
  );
}

/**
 * Agrupa em uma única mensagem por unidade e aplica o teto por hora.
 * `sentLastHour` = notificações já enviadas pela unidade na última hora.
 */
export function planNotifications(
  candidates: readonly NotifyCandidate[],
  policy: NotifyPolicy,
  sentLastHour: number
): NotificationPlan {
  if (candidates.length === 0) return { send: [], deferred: [], reason: 'nothing_to_send' };

  const sorted = [...candidates].sort(byImportance);
  const hasCritical = sorted.some(c => c.severity === 'critico' && c.reason !== 'recovered');
  if (sentLastHour >= policy.maxPerUnitPerHour && !hasCritical) {
    return { send: [], deferred: sorted, reason: 'rate_limited' };
  }
  return { send: sorted, deferred: [], reason: null };
}
