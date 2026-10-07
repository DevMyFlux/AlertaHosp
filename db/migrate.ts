// Executor de migrations versionadas.
//
// Aplica db/migrations/NNNN_nome.sql em ordem, cada uma numa transação, uma
// única vez. Guarda o checksum de cada arquivo: se uma migration já aplicada
// for editada depois, o executor se recusa a continuar (migrations são
// imutáveis; mudança = nova migration). Um advisory lock impede dois
// processos de migrar ao mesmo tempo.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Queryable } from '../api/infra/db.js';

const LOCK_KEY = 727274;
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter(f => FILE_RE.test(f))
    .sort()
    .map(name => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      return { version: name.slice(0, 4), name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(db: Db, dir: string): Promise<MigrateResult> {
  const files = readMigrations(dir);
  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = await tx.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const doneByVersion = new Map(done.rows.map(r => [r.version, r.checksum]));

    for (const file of files) {
      const prior = doneByVersion.get(file.version);
      if (prior !== undefined) {
        if (prior !== file.checksum) {
          throw new Error(`Migration ${file.name} já foi aplicada e foi modificada depois (checksum diferente). Crie uma nova migration.`);
        }
        result.alreadyApplied.push(file.name);
        continue;
      }
      await applyOne(tx, file);
      result.applied.push(file.name);
    }
  });
  return result;
}

async function applyOne(tx: Queryable, file: MigrationFile): Promise<void> {
  await tx.exec(file.sql);
  await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [file.version, file.name, file.checksum]);
}
