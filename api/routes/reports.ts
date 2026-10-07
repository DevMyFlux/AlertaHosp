// Relatórios de alertas em PDF e Excel.
//
// GET /api/reports/alerts?unit=HCN|HMB|HCN,HMB&from=AAAA-MM-DD&to=AAAA-MM-DD&format=xlsx|pdf
// Relatório com as duas unidades vira duas seções independentes (nunca mistura).

import { Router } from 'express';
import type { AppDeps } from '../context.js';
import { requireDb, unitConfigLoader } from '../context.js';
import { badRequest, dateParam, enumParam, queryString, requireUnit, route } from '../http/errors.js';
import { requireViewer } from '../http/security.js';
import { listAlerts } from '../services/queries.js';
import { renderPdf, renderXlsx } from '../services/reportRender.js';
import { buildReportModel, reportFileName, ReportIntegrityError, type ReportAlert } from '../../core/report/model.js';
import type { UnitCode } from '../../core/units.js';

const MAX_ROWS = 20_000;
const DAY = 86400000;

export function reportRoutes(deps: AppDeps): Router {
  const r = Router();
  const cfgOf = unitConfigLoader(deps);
  r.use('/reports', requireViewer(deps.env));

  r.get('/reports/alerts', route(async (req, res) => {
    const started = Date.now();
    const rawUnits = (queryString(req, 'unit') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (rawUnits.length === 0) throw badRequest('Informe a unidade (unit=HCN, unit=HMB ou unit=HCN,HMB)', 'unit_required');
    const units = [...new Set(rawUnits.map(u => requireUnit(u)))];
    const format = enumParam(req, 'format', ['xlsx', 'pdf'] as const, 'xlsx')!;
    const now = deps.now();
    const to = dateParam(req, 'to') ?? now;
    const toExclusive = new Date(to.getTime() + (queryString(req, 'to')?.length === 10 ? DAY : 0));
    const from = dateParam(req, 'from') ?? new Date(toExclusive.getTime() - 30 * DAY);
    if (from >= toExclusive) throw badRequest('A data inicial deve ser anterior à final', 'invalid_period');
    if (toExclusive.getTime() - from.getTime() > 400 * DAY) throw badRequest('Período máximo de 400 dias', 'period_too_long');

    const db = requireDb(deps);
    const byUnit: Partial<Record<UnitCode, ReportAlert[]>> = {};
    let timezone = 'America/Sao_Paulo';
    for (const unit of units) {
      const cfg = await cfgOf(unit);
      timezone = cfg.timezone;
      const { items, total } = await listAlerts(db, { unitId: cfg.id, from, to: toExclusive, includeSuspect: false, limit: MAX_ROWS }, now);
      if (total > MAX_ROWS) throw badRequest(`Mais de ${MAX_ROWS} alertas no período; reduza o intervalo`, 'too_many_rows');
      byUnit[unit] = items.map(a => ({
        id: a.id, unit: a.unit, sectorCode: a.sectorCode, sectorName: a.sectorName, openedAt: a.openedAt, recoveredAt: a.recoveredAt,
        durationMinutes: a.durationMinutes, windowName: a.windowName, peakSeverity: a.peakSeverity, peakValueKwh: a.peakValueKwh,
        baselineKwh: a.baselineKwh, totalExcessKwh: a.totalExcessKwh, totalCostBrl: a.totalCostBrl, tariffBrlPerKwh: a.tariffBrlPerKwh,
        status: a.status, notificationCount: a.notificationCount, origin: a.origin,
      }));
    }

    let model;
    try {
      model = buildReportModel({ generatedAt: now, timezone, period: { from, to: new Date(toExclusive.getTime() - 1) }, byUnit });
    } catch (error) {
      if (error instanceof ReportIntegrityError) {
        deps.log.error('report.integrity_error', { units, error: error.message });
        throw new Error(`Relatório recusado por inconsistência de unidade: ${error.message}`);
      }
      throw error;
    }

    const body = format === 'pdf' ? await renderPdf(model) : await renderXlsx(model);
    const fileName = reportFileName(model, format);
    deps.log.info('report.generated', { units, format, rows: model.sections.map(s => ({ unit: s.unit, alerts: s.totals.alerts })), bytes: body.length, ms: Date.now() - started });
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  }));

  return r;
}
