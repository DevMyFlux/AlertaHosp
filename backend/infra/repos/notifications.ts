// Notificações: fila (outbox), vínculo com alertas e controle de taxa.

import type { Queryable } from '../db.js';
import type { Severity } from '../../../core/alerts/types.js';
import type { NotifyReason } from '../../../core/alerts/policy.js';

export type NotificationStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed';

export interface NewNotification {
  unitId: number;
  channel: 'whatsapp' | 'sms';
  kind: 'alert_digest' | 'manual' | 'test';
  status: NotificationStatus;
  suppressReason?: string | null;
  recipientMasked?: string | null;
  template?: string | null;
  payload: Record<string, unknown>;
}

export async function insertNotification(q: Queryable, n: NewNotification): Promise<number> {
  const res = await q.query<{ id: number }>(
    `INSERT INTO notifications (unit_id, channel, kind, status, suppress_reason, recipient_masked, template, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    [n.unitId, n.channel, n.kind, n.status, n.suppressReason ?? null, n.recipientMasked ?? null, n.template ?? null, JSON.stringify(n.payload)]
  );
  return Number(res.rows[0].id);
}

export interface NotificationLink {
  alertId: number;
  reason: NotifyReason;
  prevNotifiedAt: Date | null;
  prevNotifiedSeverity: Severity | null;
}

export async function linkAlerts(q: Queryable, notificationId: number, links: readonly NotificationLink[]): Promise<void> {
  for (const l of links) {
    await q.query(
      `INSERT INTO notification_alerts (notification_id, alert_id, reason, prev_notified_at, prev_notified_severity)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [notificationId, l.alertId, l.reason, l.prevNotifiedAt, l.prevNotifiedSeverity]
    );
  }
}

/** Mensagens que ocuparam a "cota" da hora (enviadas ou a caminho). */
export async function countSentSince(q: Queryable, unitId: number, since: Date): Promise<number> {
  const res = await q.query<{ n: number }>(
    "SELECT count(*)::int n FROM notifications WHERE unit_id = $1 AND created_at >= $2 AND status IN ('queued', 'sending', 'sent')",
    [unitId, since]
  );
  return res.rows[0].n;
}

export interface QueuedNotification {
  id: number;
  unitId: number;
  channel: 'whatsapp' | 'sms';
  template: string | null;
  payload: Record<string, any>;
  alertIds: number[];
  createdAt: Date;
}

export async function loadQueued(q: Queryable, unitId: number): Promise<QueuedNotification[]> {
  const res = await q.query<{ id: number; unit_id: number; channel: 'whatsapp' | 'sms'; template: string | null; payload: Record<string, any>; created_at: Date }>(
    "SELECT id, unit_id, channel, template, payload, created_at FROM notifications WHERE unit_id = $1 AND status = 'queued' ORDER BY id",
    [unitId]
  );
  const out: QueuedNotification[] = [];
  for (const n of res.rows) {
    const links = await q.query<{ alert_id: number }>('SELECT alert_id FROM notification_alerts WHERE notification_id = $1', [n.id]);
    out.push({ id: Number(n.id), unitId: Number(n.unit_id), channel: n.channel, template: n.template, payload: n.payload, alertIds: links.rows.map(l => Number(l.alert_id)), createdAt: new Date(n.created_at) });
  }
  return out;
}

export async function markSending(q: Queryable, id: number): Promise<boolean> {
  const res = await q.query("UPDATE notifications SET status = 'sending', attempts = attempts + 1 WHERE id = $1 AND status = 'queued'", [id]);
  return res.rowCount === 1;
}

export async function markSent(q: Queryable, id: number, detail: Record<string, unknown>): Promise<void> {
  await q.query(
    "UPDATE notifications SET status = 'sent', sent_at = now(), payload = payload || $2::jsonb, error = NULL WHERE id = $1",
    [id, JSON.stringify({ result: detail })]
  );
}

/**
 * Falha no envio: marca como failed e restaura o estado de notificação dos
 * alertas envolvidos, para que o motor volte a propor o aviso no próximo ciclo.
 */
export async function markFailed(q: Queryable, id: number, error: string, detail: Record<string, unknown> = {}): Promise<void> {
  await q.query(
    "UPDATE notifications SET status = 'failed', error = $2, payload = payload || $3::jsonb WHERE id = $1",
    [id, error.slice(0, 1000), JSON.stringify({ result: detail })]
  );
  await q.query(
    `UPDATE alerts a
        SET last_notified_at = na.prev_notified_at, last_notified_severity = na.prev_notified_severity,
            notification_count = GREATEST(a.notification_count - 1, 0), updated_at = now()
       FROM notification_alerts na
      WHERE na.notification_id = $1 AND na.alert_id = a.id`,
    [id]
  );
}

export interface NotificationRow {
  id: number;
  unitCode: string;
  kind: string;
  channel: string;
  status: string;
  suppressReason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  error: string | null;
  alertCount: number;
}

export async function listNotifications(q: Queryable, unitId: number, limit: number): Promise<NotificationRow[]> {
  const res = await q.query<Record<string, any>>(
    `SELECT n.id, u.code AS unit_code, n.kind, n.channel, n.status, n.suppress_reason, n.created_at, n.sent_at, n.error,
            (SELECT count(*)::int FROM notification_alerts na WHERE na.notification_id = n.id) AS alert_count
       FROM notifications n JOIN units u ON u.id = n.unit_id
      WHERE n.unit_id = $1 ORDER BY n.id DESC LIMIT $2`,
    [unitId, limit]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    unitCode: r.unit_code,
    kind: r.kind,
    channel: r.channel,
    status: r.status,
    suppressReason: r.suppress_reason,
    createdAt: new Date(r.created_at),
    sentAt: r.sent_at ? new Date(r.sent_at) : null,
    error: r.error,
    alertCount: Number(r.alert_count),
  }));
}

/** Envios que ficaram em "sending" (processo interrompido no meio): resultado desconhecido. */
export async function loadStuckSending(q: Queryable, unitId: number, olderThan: Date): Promise<number[]> {
  const res = await q.query<{ id: number }>(
    "SELECT id FROM notifications WHERE unit_id = $1 AND status = 'sending' AND created_at < $2",
    [unitId, olderThan]
  );
  return res.rows.map(r => Number(r.id));
}
