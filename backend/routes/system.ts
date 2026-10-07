// Saúde do serviço e sessão do painel.

import express, { Router } from 'express';
import type { AppDeps } from '../context.js';
import { badRequest, HttpError, route } from '../http/errors.js';
import { attemptLimiter, clearSessionCookie, clientKey, createSessionToken, isAuthenticated, safeEqual, sessionCookie, sessionSecretOf } from '../http/security.js';
import { UNIT_CODES } from '../../core/units.js';
import { loadUnitState } from '../infra/repos/state.js';
import { listUnits } from '../infra/repos/config.js';

export function systemRoutes(deps: AppDeps): Router {
  const r = Router();
  const loginLimit = attemptLimiter(10, 15 * 60_000);
  const secureCookie = deps.env.nodeEnv === 'production';

  // Público: só informa se está de pé e se os dados estão chegando. Nada de segredo, nada de destinatário.
  r.get('/health', route(async (_req, res) => {
    let dbStatus: 'ok' | 'not_configured' | 'error' = 'not_configured';
    const units: Record<string, unknown>[] = [];
    if (deps.db) {
      try {
        await deps.db.query('SELECT 1');
        dbStatus = 'ok';
        const known = await listUnits(deps.db);
        const now = deps.now();
        for (const u of known) {
          const st = await loadUnitState(deps.db, u.id);
          const notify = deps.notifier.describe(u.code);
          units.push({
            code: u.code,
            lastReadingTs: st.lastReadingTs,
            ageMinutes: st.lastReadingTs ? Math.round((now.getTime() - st.lastReadingTs.getTime()) / 60000) : null,
            sourceStatus: st.sourceStatus,
            lastCycleAt: st.lastCycleAt,
            lastCycleStatus: st.lastCycleStatus,
            notificationsConfigured: notify.problem === null,
          });
        }
      } catch (error: any) {
        dbStatus = 'error';
        deps.log.error('db.error', { where: 'health', error: error?.message ?? String(error) });
      }
    }
    const ok = dbStatus === 'ok';
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version: deps.version,
      database: dbStatus,
      authRequired: !!deps.env.accessPassword,
      shadowMode: deps.env.shadowMode,
      units,
      expectedUnits: UNIT_CODES,
    });
  }));

  r.get('/auth/me', route(async (req, res) => {
    res.json({ authRequired: !!deps.env.accessPassword, authenticated: !deps.env.accessPassword || isAuthenticated(req, deps.env) });
  }));

  r.post('/auth/login', express.json({ limit: '2kb' }), route(async (req, res) => {
    const password = deps.env.accessPassword;
    if (!password) throw new HttpError(404, 'auth_disabled', 'Login não está habilitado');
    const key = clientKey(req);
    loginLimit.assertAllowed(key);
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!given) throw badRequest('Informe a senha');
    if (!safeEqual(given, password)) {
      loginLimit.recordFailure(key);
      deps.log.warn('auth.failed', { ip: key });
      throw new HttpError(401, 'invalid_credentials', 'Senha incorreta');
    }
    loginLimit.reset(key);
    const secret = sessionSecretOf(deps.env)!;
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(secret), secureCookie));
    res.json({ authenticated: true });
  }));

  r.post('/auth/logout', route(async (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie(secureCookie));
    res.json({ authenticated: false });
  }));

  return r;
}
