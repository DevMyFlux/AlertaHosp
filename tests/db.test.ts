import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, MIGRATIONS_DIR } from '../scripts/lib/pgliteDb.js';
import { migrate, readMigrations } from '../db/migrate.js';
import { seedReferenceData } from '../db/seed.js';
import { loadUnitConfig } from '../api/infra/repos/config.js';
import type { Db } from '../api/infra/db.js';
import { UNITS } from '../core/units.js';

let db: Db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

async function sectorId(unit: string, code: string): Promise<{ id: number; unitId: number }> {
  const r = await db.query<{ id: number; unit_id: number }>(
    'SELECT s.id, s.unit_id FROM sectors s JOIN units u ON u.id = s.unit_id WHERE u.code = $1 AND s.code = $2',
    [unit, code]
  );
  return { id: r.rows[0].id, unitId: r.rows[0].unit_id };
}

describe('migrations e seed', () => {
  test('aplica todas as migrations em ordem e é idempotente', async () => {
    const again = await migrate(db, MIGRATIONS_DIR);
    assert.deepEqual(again.applied, []);
    assert.equal(again.alreadyApplied.length, readMigrations(MIGRATIONS_DIR).length);
  });

  test('seed é idempotente e cadastra as duas unidades com seus setores', async () => {
    await db.transaction(tx => seedReferenceData(tx));
    await db.transaction(tx => seedReferenceData(tx));
    const units = await db.query<{ code: string; n: number }>(
      'SELECT u.code, count(s.id)::int n FROM units u JOIN sectors s ON s.unit_id = u.id GROUP BY u.code ORDER BY u.code'
    );
    assert.deepEqual(units.rows, [
      { code: 'HCN', n: UNITS.HCN.sectors.length },
      { code: 'HMB', n: UNITS.HMB.sectors.length },
    ]);
  });

  test('migration alterada depois de aplicada é recusada', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE tmp_a (id int);');
    const scratch = await createTestDb({ migrate: false });
    try {
      await migrate(scratch, dir);
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE tmp_a (id int, extra int);');
      await assert.rejects(() => migrate(scratch, dir), /modificada depois/);
    } finally {
      await scratch.close();
    }
  });

  test('configuração da unidade vem do banco com regras e faixas válidas', async () => {
    const cfg = await loadUnitConfig(db, 'HMB');
    assert.equal(cfg.code, 'HMB');
    assert.equal(cfg.expectedIntervalMin, 10);
    assert.equal(cfg.sectors.length, UNITS.HMB.sectors.length);
    assert.equal(cfg.windows.length, 7);
    assert.equal(cfg.rules.levels.alto.persistence, 2);
    assert.equal(cfg.policy.notifyFrom, 'alto');
    const hcn = await loadUnitConfig(db, 'HCN');
    assert.equal(hcn.expectedIntervalMin, 15);
  });

  test('regra específica da unidade sobrepõe a global e campos novos herdam o padrão', async () => {
    const hcn = await db.query<{ id: number }>("SELECT id FROM units WHERE code = 'HCN'");
    await db.query(
      "INSERT INTO alert_rules (unit_id, version, rules, notify_policy) VALUES ($1, 'hcn-custom', $2::jsonb, '{}'::jsonb)",
      [hcn.rows[0].id, JSON.stringify({ recoveryReadings: 5 })]
    );
    const cfg = await loadUnitConfig(db, 'HCN');
    assert.equal(cfg.rules.recoveryReadings, 5);
    assert.equal(cfg.rules.levels.alto.z, 4.5, 'o resto vem do padrão');
    const hmb = await loadUnitConfig(db, 'HMB');
    assert.equal(hmb.rules.recoveryReadings, 3, 'a outra unidade não é afetada');
    await db.query("DELETE FROM alert_rules WHERE version = 'hcn-custom'");
  });
});

describe('integridade HCN × HMB no banco', () => {
  test('leitura de um setor do HCN não pode ser gravada como HMB (FK composta)', async () => {
    const hcn = await sectorId('HCN', 'DJ50_CME');
    const hmb = await db.query<{ id: number }>("SELECT id FROM units WHERE code = 'HMB'");
    await assert.rejects(
      () => db.query("INSERT INTO readings (sector_id, unit_id, ts, counter_kwh) VALUES ($1, $2, now(), 1)", [hcn.id, hmb.rows[0].id]),
      /foreign key|violates/i
    );
    await db.query('INSERT INTO readings (sector_id, unit_id, ts, counter_kwh) VALUES ($1, $2, now(), 1)', [hcn.id, hcn.unitId]);
  });

  test('alerta de um setor do HMB não pode apontar para o HCN', async () => {
    const hmbSector = await sectorId('HMB', 'ME_CME_hmb');
    const hcn = await db.query<{ id: number }>("SELECT id FROM units WHERE code = 'HCN'");
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO alerts (unit_id, sector_id, status, severity, peak_severity, window_key, window_name, opened_at, severity_changed_at, last_breach_at, tariff_brl_per_kwh, rules_version)
           VALUES ($1, $2, 'open', 'alto', 'alto', 'tarde', 'Tarde', now(), now(), now(), 0.75, 't')`,
          [hcn.rows[0].id, hmbSector.id]
        ),
      /foreign key|violates/i
    );
  });

  test('só pode haver um alerta aberto por setor', async () => {
    const s = await sectorId('HMB', 'ME_COZINHA_hmb');
    const insert = () =>
      db.query(
        `INSERT INTO alerts (unit_id, sector_id, status, severity, peak_severity, window_key, window_name, opened_at, severity_changed_at, last_breach_at, tariff_brl_per_kwh, rules_version)
         VALUES ($1, $2, 'open', 'alto', 'alto', 'tarde', 'Tarde', now(), now(), now(), 0.75, 't')`,
        [s.unitId, s.id]
      );
    await insert();
    await assert.rejects(insert, /duplicate key|unique/i);
    await db.query("UPDATE alerts SET status = 'recovered', recovered_at = now() WHERE sector_id = $1", [s.id]);
    await insert(); // depois de recuperado pode abrir outro
  });

  test('status e recovered_at precisam ser coerentes; alerta do motor exige severidade', async () => {
    const s = await sectorId('HMB', 'ME_VACUO_hmb');
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO alerts (unit_id, sector_id, status, severity, peak_severity, window_key, window_name, opened_at, severity_changed_at, last_breach_at, tariff_brl_per_kwh, rules_version, recovered_at)
           VALUES ($1, $2, 'open', 'alto', 'alto', 'x', 'X', now(), now(), now(), 0.75, 't', now())`,
          [s.unitId, s.id]
        ),
      /check/i
    );
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO alerts (unit_id, sector_id, status, window_key, window_name, opened_at, severity_changed_at, last_breach_at, tariff_brl_per_kwh, rules_version)
           VALUES ($1, $2, 'open', 'x', 'X', now(), now(), now(), 0.75, 't')`,
          [s.unitId, s.id]
        ),
      /check/i
    );
  });

  test('faixa operacional inválida (início ≥ fim) é recusada', async () => {
    const hcn = await db.query<{ id: number }>("SELECT id FROM units WHERE code = 'HCN'");
    await assert.rejects(
      () => db.query("INSERT INTO operational_windows (unit_id, key, name, start_min, end_min) VALUES ($1, 'x', 'X', 600, 600)", [hcn.rows[0].id]),
      /check/i
    );
  });
});
