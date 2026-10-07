import express from 'express';
import type { AppDeps } from './context.js';
import { errorHandler, HttpError } from './http/errors.js';
import { baseMiddleware } from './http/security.js';
import { adminRoutes, webhookRoutes } from './routes/admin.js';
import { cycleRoutes } from './routes/cycle.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { reportRoutes } from './routes/reports.js';
import { systemRoutes } from './routes/system.js';

/** Monta a API. Recebe as dependências prontas — nada é lido de variável de ambiente aqui. */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // atrás da Vercel: IP real para o limite de tentativas
  app.use(baseMiddleware());

  // O corpo JSON é lido por rota, com limite próprio (ver cada router).
  app.use('/api', systemRoutes(deps));
  app.use('/api', cycleRoutes(deps));
  app.use('/api', webhookRoutes(deps));
  app.use('/api', adminRoutes(deps));
  app.use('/api', dashboardRoutes(deps));
  app.use('/api', reportRoutes(deps));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Rota não encontrada')));
  app.use(errorHandler(deps.log));
  return app;
}
