// Leituras do painel: visão geral, setores, séries, alertas, notificações, configuração.
// Toda rota é escopada por unidade na URL — não existe endpoint que devolva HCN e HMB misturados.

import { Router } from 'express';
import type { AppDeps } from '../context.js';
import { requireDb, unitConfigLoader } from '../context.js';
import { dateParam, enumParam, intParam, notFound, queryString, requireUnit, route, badRequest } from '../http/errors.js';
import { requireViewer } from '../http/security.js';
import { getAlertDetail, getOverview, getSectorSeries, getSectorSnapshots, listAlerts } from '../services/queries.js';
import { listNotifications } from '../infra/repos/notifications.js';
import { SEVERITIES } from '../../core/alerts/types.js';
import { UNITS } from '../../core/units.js';

export function dashboardRoutes(deps: AppDeps): Router {
  const r = Router();
  const cfgOf = unitConfigLoader(deps);
  r.use('/units', requireViewer(deps.env));

  r.get('/units', route(async (_req, res) => {
    res.json({
      units: Object.values(UNITS).map(u => ({
        code: u.code,
        name: u.name,
        accent: u.accent,
        intervalMin: u.expectedIntervalMin,
        timezone: u.timezone,
        sectors: u.sectors.map(s => ({ code: s.code, name: s.name, kind: s.kind, monitored: s.monitored })),
      })),
    });
  }));

  r.get('/units/:unit/overview', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const days = intParam(req, 'days', 7, 1, 90);
    res.json(await getOverview(requireDb(deps), await cfgOf(unit), days, deps.now()));
  }));

  r.get('/units/:unit/sectors', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const cfg = await cfgOf(unit);
    res.json({ unit, sectors: await getSectorSnapshots(requireDb(deps), cfg, deps.now()) });
  }));

  r.get('/units/:unit/sectors/:code/series', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const cfg = await cfgOf(unit);
    const sector = cfg.sectors.find(s => s.code === req.params.code);
    if (!sector) throw notFound(`Setor ${req.params.code} não existe na unidade ${unit}`, 'sector_not_found');
    // janela explícita (from/to, máx. 14 dias) ou as últimas N horas
    const now = deps.now();
    const toParam = dateParam(req, 'to');
    const fromParam = dateParam(req, 'from');
    const to = toParam ?? now;
    const from = fromParam ?? new Date(to.getTime() - intParam(req, 'hours', 48, 1, 24 * 14) * 3600000);
    if (from >= to) throw badRequest('"from" deve ser anterior a "to"');
    if (to.getTime() - from.getTime() > 14 * 86400000) throw badRequest('Janela máxima de 14 dias');
    const points = await getSectorSeries(requireDb(deps), cfg, sector.id, from, to);
    res.json({ unit, sector: { code: sector.code, name: sector.name }, intervalMin: cfg.expectedIntervalMin, timezone: cfg.timezone, points });
  }));

  r.get('/units/:unit/alerts', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const cfg = await cfgOf(unit);
    const sectorCode = queryString(req, 'sector');
    if (sectorCode && !cfg.sectors.some(s => s.code === sectorCode)) throw badRequest(`Setor ${sectorCode} não existe na unidade ${unit}`, 'sector_not_found');
    const result = await listAlerts(requireDb(deps), {
      unitId: cfg.id,
      from: dateParam(req, 'from'),
      to: dateParam(req, 'to'),
      status: enumParam(req, 'status', ['open', 'recovered'] as const),
      severity: enumParam(req, 'severity', SEVERITIES),
      sectorCode,
      includeSuspect: queryString(req, 'includeSuspect') === 'true',
      limit: intParam(req, 'limit', 50, 1, 200),
      offset: intParam(req, 'offset', 0, 0, 1_000_000),
    }, deps.now());
    res.json({ unit, ...result });
  }));

  r.get('/units/:unit/alerts/:id', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw badRequest('Id de alerta inválido');
    const detail = await getAlertDetail(requireDb(deps), id, deps.now());
    // o alerta precisa pertencer à unidade da URL — um id do HMB nunca abre em /HCN/…
    if (!detail || detail.alert.unit !== unit) throw notFound('Alerta não encontrado nesta unidade', 'alert_not_found');
    res.json({ unit, ...detail });
  }));

  r.get('/units/:unit/notifications', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const cfg = await cfgOf(unit);
    res.json({ unit, notifications: await listNotifications(requireDb(deps), cfg.id, intParam(req, 'limit', 30, 1, 200)) });
  }));

  r.get('/units/:unit/config', route(async (req, res) => {
    const unit = requireUnit(req.params.unit);
    const cfg = await cfgOf(unit);
    const notify = deps.notifier.describe(unit);
    res.json({
      unit,
      name: cfg.name,
      timezone: cfg.timezone,
      intervalMin: cfg.expectedIntervalMin,
      tariffBrlPerKwh: cfg.tariffBrlPerKwh,
      windows: cfg.windows,
      rules: cfg.rules,
      policy: cfg.policy,
      notify: { configured: notify.problem === null, recipients: notify.recipientsMasked.length, template: notify.template },
      shadowMode: deps.env.shadowMode,
    });
  }));

  return r;
}
