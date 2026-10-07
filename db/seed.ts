// Dados de referência: unidades, setores, faixas operacionais e regras padrão.
//
// Idempotente. Atualiza nomes/classificação dos setores a partir de
// core/units.ts, mas NUNCA sobrescreve configuração operacional que alguém
// possa ter ajustado no banco (tarifa, faixas, regras).

import type { Queryable } from '../api/infra/db.js';
import { UNIT_CODES, UNITS } from '../core/units.js';
import { DEFAULT_WINDOWS } from '../core/alerts/windows.js';
import { DEFAULT_NOTIFY_POLICY, DEFAULT_RULES } from '../core/alerts/rules.js';

export async function seedReferenceData(q: Queryable): Promise<void> {
  for (const code of UNIT_CODES) {
    const unit = UNITS[code];
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO units (code, name, timezone, expected_interval_min)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, expected_interval_min = EXCLUDED.expected_interval_min
       RETURNING id`,
      [unit.code, unit.name, unit.timezone, unit.expectedIntervalMin]
    );
    const unitId = rows[0].id;

    for (const [index, s] of unit.sectors.entries()) {
      await q.query(
        `INSERT INTO sectors (unit_id, code, source_column, name, kind, monitored, related_hvac_code, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (unit_id, code) DO UPDATE
           SET source_column = EXCLUDED.source_column, name = EXCLUDED.name, kind = EXCLUDED.kind,
               monitored = EXCLUDED.monitored, related_hvac_code = EXCLUDED.related_hvac_code,
               display_order = EXCLUDED.display_order`,
        [unitId, s.code, s.sourceColumn, s.name, s.kind, s.monitored, s.relatedHvac ?? null, index]
      );
    }

    const existing = await q.query('SELECT 1 FROM operational_windows WHERE unit_id = $1 LIMIT 1', [unitId]);
    if (existing.rows.length === 0) {
      for (const [order, w] of DEFAULT_WINDOWS.entries()) {
        await q.query(
          `INSERT INTO operational_windows (unit_id, key, name, start_min, end_min, day_type, threshold_multiplier, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [unitId, w.key, w.name, w.startMin, w.endMin, w.dayType, w.thresholdMultiplier, order]
        );
      }
    }

    await q.query('INSERT INTO unit_state (unit_id) VALUES ($1) ON CONFLICT (unit_id) DO NOTHING', [unitId]);
  }

  const globalRules = await q.query('SELECT 1 FROM alert_rules WHERE unit_id IS NULL AND active LIMIT 1');
  if (globalRules.rows.length === 0) {
    await q.query(
      `INSERT INTO alert_rules (unit_id, version, rules, notify_policy, created_by)
       VALUES (NULL, $1, $2::jsonb, $3::jsonb, 'seed')`,
      [DEFAULT_RULES.version, JSON.stringify(DEFAULT_RULES), JSON.stringify(DEFAULT_NOTIFY_POLICY)]
    );
  }
}
