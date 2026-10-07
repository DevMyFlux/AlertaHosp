// Leituras: gravação idempotente, contexto para normalização e consultas de série.

import type { Queryable } from '../db.js';
import type { NormalizedReading } from '../../../core/telemetry/normalize.js';
import type { RawSample } from '../../../core/telemetry/parse.js';
import type { SectorRow } from './config.js';

const CHUNK = 2000;

export interface RawRow {
  sectorId: number;
  ts: Date;
  counter: number | null;
  quality: number | null;
}

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size) as T[]);
  return out;
}

/**
 * Grava leituras cruas. Idempotente: repetir a mesma leitura não faz nada; uma
 * leitura reenviada com valor/qualidade diferente é atualizada. Devolve quantas
 * são novas e o instante mais antigo que mudou (para saber de onde recalcular).
 */
export async function upsertRawReadings(
  q: Queryable,
  unitId: number,
  rows: readonly RawRow[],
  source: string
): Promise<{ inserted: number; changed: number; firstChangedTs: Date | null }> {
  let inserted = 0;
  let changed = 0;
  let first: Date | null = null;
  for (const part of chunks(rows)) {
    const res = await q.query<{ ts: Date; inserted: boolean }>(
      `INSERT INTO readings (sector_id, unit_id, ts, counter_kwh, quality, source)
       SELECT x.s, $1::smallint, x.t, x.c, x.q, $6
         FROM unnest($2::int[], $3::timestamptz[], $4::float8[], $5::int[]) AS x(s, t, c, q)
       ON CONFLICT (sector_id, ts) DO UPDATE
         SET counter_kwh = EXCLUDED.counter_kwh, quality = EXCLUDED.quality, status = 'pending'
         WHERE readings.counter_kwh IS DISTINCT FROM EXCLUDED.counter_kwh
            OR readings.quality IS DISTINCT FROM EXCLUDED.quality
       RETURNING ts, (xmax = 0) AS inserted`,
      [unitId, part.map(r => r.sectorId), part.map(r => r.ts), part.map(r => r.counter), part.map(r => r.quality), source]
    );
    for (const r of res.rows) {
      if (r.inserted) inserted++;
      else changed++;
      const ts = new Date(r.ts);
      if (!first || ts < first) first = ts;
    }
  }
  return { inserted, changed, firstChangedTs: first };
}

/** Quando começar a recalcular: ponto seguro anterior ao primeiro dado novo/alterado. */
export async function findContextStart(
  q: Queryable,
  unitId: number,
  firstNewTs: Date,
  stepsBack: number,
  maxLookbackMs: number
): Promise<Date> {
  // última leitura boa de cada setor monitorado — o mais antigo desses instantes é o ponto de partida
  const good = await q.query<{ ts: Date | null }>(
    `SELECT min(last_good) AS ts FROM (
       SELECT max(r.ts) AS last_good
         FROM readings r JOIN sectors s ON s.id = r.sector_id
        WHERE r.unit_id = $1 AND s.monitored AND r.ts < $2
          AND r.status IN ('baseline', 'ok', 'gap', 'stale_gap', 'quarantined', 'reset')
        GROUP BY r.sector_id) t`,
    [unitId, firstNewTs]
  );
  const floor = new Date(firstNewTs.getTime() - maxLookbackMs);
  const lastGood = good.rows[0]?.ts ? new Date(good.rows[0].ts) : firstNewTs;
  const from = lastGood < floor ? floor : lastGood;
  // recua alguns instantes de amostra para refazer a estabilização pós-evento
  const back = await q.query<{ ts: Date }>(
    `SELECT ts FROM (SELECT DISTINCT ts FROM readings WHERE unit_id = $1 AND ts <= $2 ORDER BY ts DESC LIMIT $3) x ORDER BY ts ASC LIMIT 1`,
    [unitId, from, stepsBack + 1]
  );
  return back.rows[0]?.ts ? new Date(back.rows[0].ts) : from;
}

/** Leituras cruas desde `from`, agrupadas por instante, prontas para `normalizeSamples`. */
export async function loadRawSamples(
  q: Queryable,
  unitId: number,
  from: Date,
  sectors: readonly SectorRow[]
): Promise<RawSample[]> {
  const codeById = new Map(sectors.map(s => [s.id, s.code]));
  const res = await q.query<{ sector_id: number; ts: Date; counter_kwh: number | null; quality: number | null }>(
    'SELECT sector_id, ts, counter_kwh, quality FROM readings WHERE unit_id = $1 AND ts >= $2 ORDER BY ts, sector_id',
    [unitId, from]
  );
  const byTs = new Map<number, RawSample>();
  for (const r of res.rows) {
    const ts = new Date(r.ts);
    const key = ts.getTime();
    let sample = byTs.get(key);
    if (!sample) {
      sample = { ts, values: {} };
      byTs.set(key, sample);
    }
    const code = codeById.get(r.sector_id);
    if (code) sample.values[code] = { counter: r.counter_kwh, quality: r.quality };
  }
  return [...byTs.values()];
}

/** Grava o resultado da normalização (só o que mudou). */
export async function writeDerived(
  q: Queryable,
  unitId: number,
  readings: readonly NormalizedReading[],
  sectorIdByCode: ReadonlyMap<string, number>
): Promise<number> {
  const rows = readings.filter(r => sectorIdByCode.has(r.sectorCode));
  let updated = 0;
  for (const part of chunks(rows)) {
    const res = await q.query(
      `UPDATE readings r
          SET status = x.status, delta_kwh = x.d, interval_kwh = x.i, span_minutes = x.sp,
              flags = COALESCE(string_to_array(NULLIF(x.f, ''), ','), '{}')
         FROM unnest($1::int[], $2::timestamptz[], $3::text[], $4::float8[], $5::float8[], $6::float8[], $7::text[]) AS x(s, t, status, d, i, sp, f)
        WHERE r.sector_id = x.s AND r.ts = x.t AND r.unit_id = $8
          AND (r.status, r.delta_kwh, r.interval_kwh, r.span_minutes, array_to_string(r.flags, ','))
              IS DISTINCT FROM (x.status, x.d, x.i, x.sp, x.f)`,
      [
        part.map(r => sectorIdByCode.get(r.sectorCode)),
        part.map(r => r.ts),
        part.map(r => r.status),
        part.map(r => r.deltaKwh),
        part.map(r => r.intervalKwh),
        part.map(r => r.spanMinutes),
        part.map(r => r.flags.join(',')),
        unitId,
      ]
    );
    updated += res.rowCount;
  }
  return updated;
}

export interface EvaluableReading {
  sectorId: number;
  ts: Date;
  status: string;
  intervalKwh: number | null;
}

/** Leituras do ciclo (a partir de `after`, exclusivo) que o motor deve avaliar, em ordem. */
export async function loadReadingsAfter(q: Queryable, unitId: number, after: Date | null, upTo: Date): Promise<EvaluableReading[]> {
  const res = await q.query<{ sector_id: number; ts: Date; status: string; interval_kwh: number | null }>(
    `SELECT sector_id, ts, status, interval_kwh FROM readings
      WHERE unit_id = $1 AND ts > $2 AND ts <= $3
      ORDER BY ts, sector_id`,
    [unitId, after ?? new Date(0), upTo]
  );
  return res.rows.map(r => ({ sectorId: r.sector_id, ts: new Date(r.ts), status: r.status, intervalKwh: r.interval_kwh }));
}

export async function loadBaselineSamples(q: Queryable, sectorId: number, since: Date, before: Date): Promise<{ ts: Date; kwh: number }[]> {
  const res = await q.query<{ ts: Date; interval_kwh: number }>(
    `SELECT ts, interval_kwh FROM readings
      WHERE sector_id = $1 AND status = 'ok' AND interval_kwh IS NOT NULL AND ts >= $2 AND ts < $3
      ORDER BY ts`,
    [sectorId, since, before]
  );
  return res.rows.map(r => ({ ts: new Date(r.ts), kwh: r.interval_kwh }));
}

export interface SeriesPoint {
  ts: Date;
  intervalKwh: number | null;
  status: string;
}

export async function loadSeries(q: Queryable, sectorId: number, from: Date, to: Date): Promise<SeriesPoint[]> {
  const res = await q.query<{ ts: Date; interval_kwh: number | null; status: string }>(
    'SELECT ts, interval_kwh, status FROM readings WHERE sector_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts',
    [sectorId, from, to]
  );
  return res.rows.map(r => ({ ts: new Date(r.ts), intervalKwh: r.interval_kwh, status: r.status }));
}

export interface LatestReading {
  sectorId: number;
  ts: Date;
  intervalKwh: number | null;
  status: string;
  flags: string[];
}

/** Última leitura de cada setor da unidade. */
export async function loadLatestReadings(q: Queryable, unitId: number, since: Date): Promise<LatestReading[]> {
  const res = await q.query<{ sector_id: number; ts: Date; interval_kwh: number | null; status: string; flags: string[] }>(
    `SELECT DISTINCT ON (sector_id) sector_id, ts, interval_kwh, status, flags
       FROM readings WHERE unit_id = $1 AND ts > $2
      ORDER BY sector_id, ts DESC`,
    [unitId, since]
  );
  return res.rows.map(r => ({ sectorId: r.sector_id, ts: new Date(r.ts), intervalKwh: r.interval_kwh, status: r.status, flags: r.flags ?? [] }));
}
