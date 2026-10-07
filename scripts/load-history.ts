// Carga de histórico no banco: telemetria exportada (CSV) + alertas da V1 (JSON).
//
//   Desenvolvimento (PostgreSQL local em WASM, pasta .pglite):
//     npm run dev:seed
//   Produção / banco real (DATABASE_URL), por unidade:
//     npm run history:load -- --unit HCN --csv backups/…/hcn_tel.csv --legacy backups/…/hcn_hist.json
//
// Passos (estratégia de migração sem perda):
//   1. migrations + seed;
//   2. telemetria → leituras (idempotente), normalização, baselines e avaliação histórica
//      dos últimos N dias (alertas e linha do tempo; NENHUMA mensagem é enviada);
//   3. alertas da V1 → tabela alerts (origin = legacy_import), artefatos marcados como suspeitos;
//   4. relatório de reconciliação (contagens e totais origem × destino).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { createPgDb, type Db } from '../api/infra/db.js';
import { loadAppEnv } from '../api/infra/env.js';
import { silentLogger } from '../api/infra/logger.js';
import type { Notifier, TelemetrySource } from '../api/infra/ports.js';
import { runCycle } from '../api/services/cycle.js';
import { migrate } from '../db/migrate.js';
import { seedReferenceData } from '../db/seed.js';
import { UNITS, isUnitCode, type UnitCode } from '../core/units.js';
import { loadUnitFromCsv } from './lib/load.js';
import { importLegacy, type LegacyRow } from './lib/legacy.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

class CsvSource implements TelemetrySource {
  constructor(private readonly rows: Record<string, string>[]) {}
  async fetchRows() {
    return this.rows;
  }
}

const noNotify: Notifier = {
  describe: () => ({ problem: 'carga de histórico', recipientsMasked: [], template: '' }),
  sendDigest: async () => ({ ok: false, results: [], error: 'carga de histórico não envia mensagens' }),
  sendTest: async () => ({ ok: false, results: [], error: 'carga de histórico não envia mensagens' }),
};

async function openDb(): Promise<Db> {
  if (flag('pglite')) {
    const { createTestDb, devDbDir } = await import('./lib/pgliteDb.js');
    const dir = path.resolve(arg('pglite-dir') ?? devDbDir());
    console.log(`[dev] banco local em ${dir}`);
    if (flag('reset')) fs.rmSync(dir, { recursive: true, force: true });
    return createTestDb({ dataDir: dir });
  }
  const env = loadAppEnv();
  if (!env.databaseUrl) throw new Error('DATABASE_URL não definida (ou use --pglite para o banco local de desenvolvimento)');
  const db = createPgDb({ connectionString: env.databaseUrl, ssl: env.databaseSsl, max: 2 });
  await migrate(db, path.resolve('db/migrations'));
  await db.transaction(tx => seedReferenceData(tx));
  return db;
}

async function loadUnit(db: Db, unit: UnitCode, csv: string, legacyFile: string | undefined, evaluateDays: number) {
  console.log(`\n=== ${unit} ===`);
  const loaded = loadUnitFromCsv(unit, csv);
  console.log(`telemetria: ${loaded.sampleCount} amostras (${loaded.firstTs.toISOString().slice(0, 10)} → ${loaded.lastTs.toISOString().slice(0, 16)}Z), ${loaded.events.length} evento(s) de fonte detectado(s)`);

  const text = fs.readFileSync(csv, 'utf8');
  const rows = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
  // a fonte devolve do mais novo para o mais antigo (como a planilha)
  rows.sort((a, b) => b.E3TimeStamp.localeCompare(a.E3TimeStamp));
  const clockAt = new Date(loaded.lastTs.getTime() + 60_000);

  const started = Date.now();
  const result = await runCycle(
    { db, source: new CsvSource(rows), notifier: noNotify, log: silentLogger, now: () => clockAt, shadow: true },
    unit,
    { sheetLimit: 'all', evaluateFrom: new Date(loaded.lastTs.getTime() - evaluateDays * 86400000), notify: false }
  );
  console.log(
    `ciclo: ${result.status} em ${((Date.now() - started) / 1000).toFixed(1)} s — leituras novas ${result.ingest.inserted}, ` +
      `avaliadas ${result.evaluation.readings}, alertas abertos ${result.evaluation.opened}, recuperados ${result.evaluation.recovered}`
  );
  if (result.status === 'error') throw new Error(result.error);

  if (legacyFile) {
    const legacy = (JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as { rows: LegacyRow[] }).rows;
    const report = await importLegacy(db, unit, legacy, loaded.events);
    console.log(
      `legado V1: ${report.received} linhas → ${report.inserted} inseridas, ${report.alreadyPresent} já presentes, ` +
        `${report.skippedUnknownSector} sem setor conhecido, ${report.suspect} marcadas como suspeitas`
    );
    console.log(
      `  custo na origem R$ ${report.source.costBrl.toFixed(2)} | no banco R$ ${report.stored.costBrl.toFixed(2)} ` +
        `(válido R$ ${report.stored.validCostBrl.toFixed(2)}, artefatos R$ ${report.stored.suspectCostBrl.toFixed(2)})`
    );
    console.log(`  reconciliação: ${report.reconciled ? 'OK' : 'FALHOU'}`);
    if (!report.reconciled) process.exitCode = 2;
  }
}

async function main() {
  const dir = 'backups/2026-10-07-antes-da-atualizacao';
  const db = await openDb();
  try {
    if (flag('dev')) {
      for (const unit of Object.keys(UNITS) as UnitCode[]) {
        const prefix = unit.toLowerCase();
        await loadUnit(db, unit, `${dir}/${prefix}_tel.csv`, `${dir}/${prefix}_hist.json`, Number(arg('days') ?? 21));
      }
    } else {
      const unit = arg('unit')?.toUpperCase();
      const csv = arg('csv');
      if (!isUnitCode(unit) || !csv) throw new Error('uso: --unit HCN|HMB --csv <arquivo> [--legacy <json>] [--days 21]');
      await loadUnit(db, unit, csv, arg('legacy'), Number(arg('days') ?? 21));
    }
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error('Falha:', error instanceof Error ? error.message : error);
  process.exit(1);
});
