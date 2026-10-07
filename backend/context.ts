// Dependências compartilhadas pelas rotas (injetadas — facilita testar com banco em memória).
import type { Db } from './infra/db.js';
import type { AppEnv } from './infra/env.js';
import type { Logger, Notifier, TelemetrySource } from './infra/ports.js';
import type { UnitCode } from '../core/units.js';
import { loadUnitConfig, type UnitConfig } from './infra/repos/config.js';
import { unavailable } from './http/errors.js';

export interface AppDeps {
  env: AppEnv;
  /** null = DATABASE_URL não configurada */
  db: Db | null;
  source: TelemetrySource;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  version: string;
}

export function requireDb(deps: AppDeps): Db {
  if (!deps.db) throw unavailable('Banco de dados não configurado (defina DATABASE_URL)', 'database_not_configured');
  return deps.db;
}

const CONFIG_TTL_MS = 30_000;

/** Configuração da unidade com cache curto — as telas pedem isso a cada requisição. */
export function unitConfigLoader(deps: AppDeps) {
  const cache = new Map<UnitCode, { at: number; cfg: UnitConfig }>();
  return async (unit: UnitCode): Promise<UnitConfig> => {
    const hit = cache.get(unit);
    const now = deps.now().getTime();
    if (hit && now - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const cfg = await loadUnitConfig(requireDb(deps), unit);
    cache.set(unit, { at: now, cfg });
    return cfg;
  };
}
