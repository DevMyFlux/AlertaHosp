// Adaptador PGlite → interface `Db` do sistema. Só para testes e desenvolvimento
// local (PostgreSQL real em WASM); nunca importado pelo código de produção.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Queryable, QueryResult } from '../../api/infra/db.js';
import { migrate } from '../../db/migrate.js';
import { seedReferenceData } from '../../db/seed.js';

type Executor = Pick<PGlite, 'query' | 'exec'>;

class PgliteQueryable implements Queryable {
  constructor(protected readonly target: Executor) {}

  async query<T = Record<string, any>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.target.query<T>(sql, params as unknown[]);
    // PGlite devolve affectedRows = 0 em SELECT; o driver `pg` devolve rows.length — igualamos o comportamento
    return { rows: res.rows, rowCount: Math.max(res.affectedRows ?? 0, res.rows.length) };
  }

  async exec(sql: string): Promise<void> {
    await this.target.exec(sql);
  }
}

class PgliteDb extends PgliteQueryable implements Db {
  constructor(private readonly db: PGlite) {
    super(db);
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => fn(new PgliteQueryable(tx as unknown as Executor)));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/** Banco em memória (ou em disco, se `dataDir` for informado) já migrado e com o seed aplicado. */
export async function createTestDb(options: { dataDir?: string; seed?: boolean; migrate?: boolean } = {}): Promise<Db> {
  if (options.dataDir) fs.mkdirSync(options.dataDir, { recursive: true });
  const pglite = new PGlite(options.dataDir, {
    // numeric (tarifa, custo) como number, igual ao driver `pg` configurado em api/infra/db.ts
    parsers: { 1700: (v: string) => Number(v) },
  });
  await pglite.waitReady;
  const db = new PgliteDb(pglite);
  if (options.migrate !== false) await migrate(db, MIGRATIONS_DIR);
  if (options.migrate !== false && options.seed !== false) await db.transaction(tx => seedReferenceData(tx));
  return db;
}

/** Apaga todos os dados operacionais (leituras, alertas, notificações, estado), mantendo a configuração. */
export async function resetOperationalData(db: Db): Promise<void> {
  await db.exec(`
    TRUNCATE notification_alerts, notifications, alert_events, alerts, system_events, ingest_runs, audit_log,
             sector_baselines, sector_state, readings RESTART IDENTITY CASCADE;
    UPDATE unit_state SET last_reading_ts = NULL, last_evaluated_ts = NULL, source_status = 'unknown',
                          source_status_changed_at = NULL, last_cycle_at = NULL, last_cycle_status = NULL, last_cycle_summary = NULL;
  `);
}

/**
 * Pasta do banco local de desenvolvimento. Fica FORA da pasta do projeto de propósito: se o projeto
 * estiver numa pasta sincronizada (OneDrive/Dropbox), o sincronizador trava os arquivos do banco
 * ("could not create lock file postmaster.pid: Permission denied").
 */
export function devDbDir(): string {
  if (process.env.DEV_DB_DIR) return path.resolve(process.env.DEV_DB_DIR);
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'alertas-energia-dev', 'pglite');
}
