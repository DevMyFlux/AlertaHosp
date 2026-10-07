// Configuração operacional lida do banco: unidade, setores, faixas, regras.

import type { Queryable } from '../db.js';
import type { UnitCode } from '../../../core/units.js';
import type { SectorKind } from '../../../core/units.js';
import { DEFAULT_NOTIFY_POLICY, DEFAULT_RULES, type NotifyPolicy, type RuleSet } from '../../../core/alerts/rules.js';
import { validateWindows, type OperationalWindow } from '../../../core/alerts/windows.js';

export interface SectorRow {
  id: number;
  unitId: number;
  code: string;
  sourceColumn: string;
  name: string;
  kind: SectorKind;
  monitored: boolean;
  relatedHvacCode: string | null;
}

export interface UnitConfig {
  id: number;
  code: UnitCode;
  name: string;
  timezone: string;
  expectedIntervalMin: number;
  tariffBrlPerKwh: number;
  sectors: SectorRow[];
  windows: OperationalWindow[];
  rules: RuleSet;
  policy: NotifyPolicy;
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Mescla `patch` sobre `base` recursivamente — campos novos nas regras padrão não quebram linhas antigas do banco. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T)) ?? base;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge((base as Json)[k], v) : v;
  return out as T;
}

export async function loadUnitConfig(q: Queryable, code: UnitCode): Promise<UnitConfig> {
  const unit = await q.query<{
    id: number;
    code: UnitCode;
    name: string;
    timezone: string;
    expected_interval_min: number;
    tariff_brl_per_kwh: number;
  }>('SELECT id, code, name, timezone, expected_interval_min, tariff_brl_per_kwh FROM units WHERE code = $1 AND active', [code]);
  if (unit.rows.length === 0) throw new Error(`Unidade ${code} não cadastrada no banco (rode o seed).`);
  const u = unit.rows[0];

  const sectors = await q.query<{
    id: number;
    unit_id: number;
    code: string;
    source_column: string;
    name: string;
    kind: SectorKind;
    monitored: boolean;
    related_hvac_code: string | null;
  }>('SELECT id, unit_id, code, source_column, name, kind, monitored, related_hvac_code FROM sectors WHERE unit_id = $1 ORDER BY display_order, id', [u.id]);

  const windowRows = await q.query<{
    key: string;
    name: string;
    start_min: number;
    end_min: number;
    day_type: OperationalWindow['dayType'];
    threshold_multiplier: number;
  }>('SELECT key, name, start_min, end_min, day_type, threshold_multiplier FROM operational_windows WHERE unit_id = $1 AND active ORDER BY sort_order, id', [u.id]);
  const windows: OperationalWindow[] = windowRows.rows.map(w => ({
    key: w.key,
    name: w.name,
    startMin: w.start_min,
    endMin: w.end_min,
    dayType: w.day_type,
    thresholdMultiplier: Number(w.threshold_multiplier),
  }));
  const problems = validateWindows(windows);
  if (problems.length > 0) throw new Error(`Faixas operacionais inválidas para ${code}: ${problems.join('; ')}`);

  // regra específica da unidade, se houver; senão a global
  const ruleRows = await q.query<{ rules: unknown; notify_policy: unknown; version: string }>(
    `SELECT rules, notify_policy, version FROM alert_rules
      WHERE active AND (unit_id = $1 OR unit_id IS NULL)
      ORDER BY unit_id NULLS LAST LIMIT 1`,
    [u.id]
  );
  const rules = deepMerge(DEFAULT_RULES, ruleRows.rows[0]?.rules);
  const policy = deepMerge(DEFAULT_NOTIFY_POLICY, ruleRows.rows[0]?.notify_policy);

  return {
    id: u.id,
    code: u.code,
    name: u.name,
    timezone: u.timezone,
    expectedIntervalMin: u.expected_interval_min,
    tariffBrlPerKwh: Number(u.tariff_brl_per_kwh),
    sectors: sectors.rows.map(s => ({
      id: s.id,
      unitId: s.unit_id,
      code: s.code,
      sourceColumn: s.source_column,
      name: s.name,
      kind: s.kind,
      monitored: s.monitored,
      relatedHvacCode: s.related_hvac_code,
    })),
    windows,
    rules,
    policy,
  };
}

export async function listUnits(q: Queryable): Promise<{ id: number; code: UnitCode; name: string }[]> {
  const res = await q.query<{ id: number; code: UnitCode; name: string }>('SELECT id, code, name FROM units WHERE active ORDER BY id');
  return res.rows;
}
