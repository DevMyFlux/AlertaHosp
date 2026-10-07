// Composição das dependências reais (produção e desenvolvimento).
import type { AppDeps } from './context.js';
import { createPgDb, redactConnectionString, type Db } from './infra/db.js';
import { loadAppEnv, type AppEnv } from './infra/env.js';
import { createLogger } from './infra/logger.js';
import { SheetTelemetrySource } from './infra/sheetSource.js';
import { VonageNotifier } from './infra/vonage.js';

export function buildDeps(overrides: { db?: Db | null; env?: AppEnv } = {}): AppDeps {
  const env = overrides.env ?? loadAppEnv();
  const log = createLogger();
  let db: Db | null = overrides.db !== undefined ? overrides.db : null;
  if (overrides.db === undefined && env.databaseUrl) {
    db = createPgDb({ connectionString: env.databaseUrl, ssl: env.databaseSsl });
    log.info('db.configured', { url: redactConnectionString(env.databaseUrl) });
  } else if (!db) {
    log.warn('db.not_configured', { hint: 'defina DATABASE_URL; sem banco só /api/health e /api/auth respondem' });
  }
  return {
    env,
    db,
    source: new SheetTelemetrySource(),
    notifier: new VonageNotifier(env, log),
    log,
    now: () => new Date(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? 'dev',
  };
}
