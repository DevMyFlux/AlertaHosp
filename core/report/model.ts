// Modelo de relatório de alertas — única fonte para PDF e Excel.
//
// Regra de ouro: um registro do HCN nunca pode sair como HMB (nem vice-versa).
// `buildReportModel` recusa montar o relatório se qualquer linha estiver na
// seção errada ou se o setor da linha não pertencer à unidade da seção
// (checagem cruzada com o registro de setores). Relatório com as duas unidades
// vira DUAS seções independentes, cada uma com seus próprios totais.

import { UNITS, UNIT_CODES, type UnitCode } from '../units.js';
import { SEVERITY_LABEL, type Severity } from '../alerts/types.js';

export interface ReportAlert {
  id: number;
  unit: UnitCode;
  sectorCode: string;
  sectorName: string;
  openedAt: Date;
  recoveredAt: Date | null;
  durationMinutes: number;
  windowName: string;
  peakSeverity: Severity | null;
  peakValueKwh: number;
  baselineKwh: number;
  totalExcessKwh: number;
  totalCostBrl: number;
  tariffBrlPerKwh: number;
  status: 'open' | 'recovered';
  notificationCount: number;
  origin: 'engine' | 'legacy_import';
}

export interface ReportRow extends ReportAlert {
  alertType: string;
  severityLabel: string;
}

export interface SectorTotal {
  sectorCode: string;
  sectorName: string;
  alerts: number;
  excessKwh: number;
  costBrl: number;
}

export interface ReportSection {
  unit: UnitCode;
  unitName: string;
  rows: ReportRow[];
  totals: { alerts: number; excessKwh: number; costBrl: number; notifications: number };
  bySector: SectorTotal[];
}

export interface ReportModel {
  title: string;
  generatedAt: Date;
  timezone: string;
  period: { from: Date; to: Date };
  sections: ReportSection[];
}

export class ReportIntegrityError extends Error {}

export function alertTypeLabel(a: Pick<ReportAlert, 'origin'>): string {
  return a.origin === 'legacy_import' ? 'Consumo acima do padrão (histórico V1)' : 'Consumo acima do esperado';
}

export function severityLabel(s: Severity | null): string {
  return s ? SEVERITY_LABEL[s] : 'Não classificado';
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function buildSection(unit: UnitCode, alerts: readonly ReportAlert[]): ReportSection {
  const def = UNITS[unit];
  const known = new Set(def.sectors.map(s => s.code));
  for (const a of alerts) {
    if (a.unit !== unit) {
      throw new ReportIntegrityError(`Registro #${a.id} é da unidade ${a.unit}, mas está na seção ${unit}`);
    }
    if (!known.has(a.sectorCode)) {
      throw new ReportIntegrityError(`Setor ${a.sectorCode} (alerta #${a.id}) não pertence à unidade ${unit}`);
    }
  }

  const rows: ReportRow[] = [...alerts]
    .sort((x, y) => x.openedAt.getTime() - y.openedAt.getTime() || x.id - y.id)
    .map(a => ({ ...a, alertType: alertTypeLabel(a), severityLabel: severityLabel(a.peakSeverity) }));

  const bySector = new Map<string, SectorTotal>();
  for (const r of rows) {
    const s = bySector.get(r.sectorCode) ?? { sectorCode: r.sectorCode, sectorName: r.sectorName, alerts: 0, excessKwh: 0, costBrl: 0 };
    s.alerts += 1;
    s.excessKwh += r.totalExcessKwh;
    s.costBrl += r.totalCostBrl;
    bySector.set(r.sectorCode, s);
  }

  return {
    unit,
    unitName: def.name,
    rows,
    totals: {
      alerts: rows.length,
      excessKwh: round(rows.reduce((t, r) => t + r.totalExcessKwh, 0), 3),
      costBrl: round(rows.reduce((t, r) => t + r.totalCostBrl, 0), 2),
      notifications: rows.reduce((t, r) => t + r.notificationCount, 0),
    },
    bySector: [...bySector.values()]
      .map(s => ({ ...s, excessKwh: round(s.excessKwh, 3), costBrl: round(s.costBrl, 2) }))
      .sort((a, b) => b.costBrl - a.costBrl || b.alerts - a.alerts),
  };
}

export function buildReportModel(input: {
  title?: string;
  generatedAt: Date;
  timezone: string;
  period: { from: Date; to: Date };
  /** alertas já separados por unidade; a ordem das chaves define a ordem das seções */
  byUnit: Partial<Record<UnitCode, readonly ReportAlert[]>>;
}): ReportModel {
  const sections: ReportSection[] = [];
  for (const unit of UNIT_CODES) {
    const alerts = input.byUnit[unit];
    if (alerts === undefined) continue;
    sections.push(buildSection(unit, alerts));
  }
  if (sections.length === 0) throw new ReportIntegrityError('Relatório sem nenhuma unidade');
  const unitsLabel = sections.map(s => s.unit).join(' + ');
  return {
    title: input.title ?? `Relatório de alertas de consumo — ${unitsLabel}`,
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    period: input.period,
    sections,
  };
}

/** Nome de arquivo sempre identifica unidade(s) e período. */
export function reportFileName(model: ReportModel, ext: 'xlsx' | 'pdf'): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const units = model.sections.map(s => s.unit).join('-');
  return `alertas_${units}_${day(model.period.from)}_a_${day(model.period.to)}.${ext}`;
}
