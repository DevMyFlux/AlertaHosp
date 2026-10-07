// Ações administrativas (exigem sessão) e webhooks da Vonage.

import crypto from 'node:crypto';
import express, { Router } from 'express';
import type { AppDeps } from '../context.js';
import { requireDb, unitConfigLoader } from '../context.js';
import { HttpError, requireUnit, route } from '../http/errors.js';
import { callLimiter, clientKey, requireAdmin, safeEqual } from '../http/security.js';
import { insertNotification, markFailed } from '../infra/repos/notifications.js';
import { parseStatusWebhook } from '../infra/vonage.js';

export function adminRoutes(deps: AppDeps): Router {
  const r = Router();
  const cfgOf = unitConfigLoader(deps);
  const testLimit = callLimiter(5, 10 * 60_000);

  // Mensagem de teste para os destinatários da unidade — custa dinheiro, então só com sessão.
  r.post('/units/:unit/notifications/test', requireAdmin(deps.env), route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    testLimit(clientKey(req));
    const db = requireDb(deps);
    const cfg = await cfgOf(unit);
    const desc = deps.notifier.describe(unit);
    if (desc.problem) throw new HttpError(409, 'notify_not_configured', `Notificação não configurada: ${desc.problem}`);
    const outcome = await deps.notifier.sendTest(unit, 'mensagem de teste do sistema de alertas — pode ignorar');
    await insertNotification(db, {
      unitId: cfg.id, channel: 'whatsapp', kind: 'test', status: outcome.ok ? 'sent' : 'failed',
      recipientMasked: desc.recipientsMasked.join(','), template: desc.template, payload: { result: { recipients: outcome.results } },
    });
    await db.query('INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)', [
      'admin', 'notification.test', 'unit', unit, JSON.stringify({ ok: outcome.ok }),
    ]);
    deps.log.info('notification.test', { unit, ok: outcome.ok });
    res.status(outcome.ok ? 200 : 502).json({ ok: outcome.ok, results: outcome.results, error: outcome.error });
  }));

  return r;
}

/** Valida o JWT HS256 assinado pela Vonage (Authorization: Bearer) com a chave de assinatura da conta. */
function verifyVonageSignature(authHeader: string | undefined, secret: string): boolean {
  const token = /^Bearer\s+(.+)$/i.exec(authHeader ?? '')?.[1];
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  return safeEqual(expected, parts[2]);
}

export function webhookRoutes(deps: AppDeps): Router {
  const r = Router();
  const limit = callLimiter(300, 60_000);

  // A Vonage aceita o envio na hora e só informa a rejeição real da Meta depois, aqui.
  r.post('/webhooks/vonage-status', express.json({ limit: '32kb' }), route(async (req, res) => {
    limit(clientKey(req));
    const secret = process.env.VONAGE_SIGNATURE_SECRET;
    if (secret && !verifyVonageSignature(req.headers.authorization, secret)) throw new HttpError(401, 'bad_signature', 'Assinatura inválida');
    const { messageUuid, status, error } = parseStatusWebhook(req.body);
    deps.log.info('notification.provider_status', { messageUuid, status, error });
    if (deps.db && messageUuid && status && ['rejected', 'failed', 'undeliverable'].includes(status)) {
      const found = await deps.db.query<{ id: number }>(
        "SELECT id FROM notifications WHERE payload->'result'->'recipients' @> $1::jsonb AND status = 'sent' LIMIT 1",
        [JSON.stringify([{ messageUuid }])]
      );
      if (found.rows[0]) {
        await markFailed(deps.db, Number(found.rows[0].id), `Rejeitada pelo provedor (${status}): ${error ?? 'sem detalhe'}`);
        deps.log.error('notification.rejected_by_provider', { notificationId: found.rows[0].id, status, error });
      }
    }
    res.sendStatus(200);
  }));

  r.post('/webhooks/vonage-inbound', express.json({ limit: '32kb' }), (_req, res) => {
    res.sendStatus(200); // mensagens recebidas não são usadas; resposta vazia, sem registrar conteúdo
  });

  return r;
}
