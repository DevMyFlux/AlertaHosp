// Endpoints de máquina: ciclo agendado e ingestão direta.
//
//  • /api/cron-check — chamado a cada 15 min pelo gatilho do Apps Script (HCN e
//    HMB têm gatilhos separados, com `?hospital=hmb` no HMB). Mantém o mesmo
//    caminho e o mesmo header da V1, então o Apps Script em produção continua
//    funcionando sem alteração.
//  • /api/ingest/:unit — a máquina do hospital pode enviar as leituras direto
//    (sem passar pela planilha); mesma normalização e mesmo motor.

import express, { Router } from 'express';
import type { AppDeps } from '../context.js';
import { requireDb } from '../context.js';
import { badRequest, legacyUnit, queryString, requireUnit, route } from '../http/errors.js';
import { checkBearer } from '../http/security.js';
import { runCycle } from '../services/cycle.js';
import type { TelemetrySource } from '../infra/ports.js';
import type { UnitDef } from '../../core/units.js';

export function cycleRoutes(deps: AppDeps): Router {
  const r = Router();

  const handler = route(async (req, res) => {
    // `hospital` (legado) ou `unit`; valor desconhecido é erro, nunca "cai" em outro hospital
    const unit = legacyUnit(queryString(req, 'hospital') ?? queryString(req, 'unit'));
    checkBearer(req, deps.env.units[unit].cronSecret);
    const db = requireDb(deps);
    const result = await runCycle({ db, source: deps.source, notifier: deps.notifier, log: deps.log, now: deps.now, shadow: deps.env.shadowMode }, unit);
    res.status(result.status === 'error' ? 502 : 200).json({ ok: result.status !== 'error', hospital: unit, ...result });
  });
  r.get('/cron-check', handler);
  r.post('/cron-check', handler);

  r.post('/ingest/:unit', express.json({ limit: '4mb' }), route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    checkBearer(req, deps.env.units[unit].ingestKey);
    const rows: unknown = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) throw badRequest('"rows" deve ser uma lista de 1 a 5000 leituras');
    const clean: Record<string, string>[] = [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) throw badRequest('Cada leitura deve ser um objeto');
      clean.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
    }
    const pushed: TelemetrySource = { fetchRows: async (_u: UnitDef) => clean };
    const result = await runCycle(
      { db: requireDb(deps), source: pushed, notifier: deps.notifier, log: deps.log, now: deps.now, shadow: deps.env.shadowMode },
      unit,
      { sheetLimit: 'all' }
    );
    res.status(result.status === 'error' ? 502 : 200).json({ ok: result.status !== 'error', ...result });
  }));

  return r;
}
