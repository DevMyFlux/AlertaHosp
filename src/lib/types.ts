// Formato das respostas da API (JSON: datas chegam como texto ISO).
import type { UnitCode } from '../../core/unitMeta';

export type Severity = 'atencao' | 'alto' | 'critico';
export type SectorStateKey = 'normal' | Severity | 'learning' | 'no_data' | 'quarantine';

export interface UnitInfo {
  code: UnitCode;
  name: string;
  accent: string;
  intervalMin: number;
  timezone: string;
  sectors: { code: string; name: string; kind: string; monitored: boolean }[];
}

export interface AlertItem {
  id: number;
  unit: UnitCode;
  sectorCode: string;
  sectorName: string;
  status: 'open' | 'recovered';
  severity: Severity | null;
  peakSeverity: Severity | null;
  windowName: string;
  openedAt: string;
  recoveredAt: string | null;
  durationMinutes: number;
  breachCount: number;
  peakValueKwh: number;
  baselineKwh: number;
  peakPctOver: number | null;
  totalExcessKwh: number;
  totalCostBrl: number;
  tariffBrlPerKwh: number;
  notificationCount: number;
  lastNotifiedAt: string | null;
  origin: 'engine' | 'legacy_import';
  suspect: boolean;
  suspectReason: string | null;
}

export interface Overview {
  unit: { code: UnitCode; name: string; intervalMin: number; timezone: string };
  period: { from: string; to: string; days: number };
  freshness: { lastReadingTs: string | null; ageMinutes: number | null; sourceStatus: 'unknown' | 'online' | 'stale'; lastCycleAt: string | null; lastCycleStatus: string | null };
  totals: { alerts: number; byPeak: Record<Severity, number>; excessKwh: number; costBrl: number; notificationsSent: number; openNow: number };
  openAlerts: AlertItem[];
  bySector: { sectorCode: string; sectorName: string; alerts: number; excessKwh: number; costBrl: number }[];
  byHour: { hour: number; alerts: number }[];
  consumption: { hour: string; kwh: number; coverage: number }[];
  sourceEvents: { ts: string; kind: string; detail: Record<string, unknown> }[];
}

export interface SectorSnapshot {
  code: string;
  name: string;
  kind: string;
  monitored: boolean;
  state: SectorStateKey;
  ts: string | null;
  valueKwh: number | null;
  expectedKwh: number | null;
  pctOver: number | null;
  limits: Record<Severity, number> | null;
  window: string | null;
  baselineSamples: number | null;
  openAlertId: number | null;
  openSeverity: Severity | null;
  openedAt: string | null;
  flags: string[];
}

export interface SeriesPoint {
  ts: string;
  kwh: number | null;
  status: string;
  expected: number | null;
  limitAtencao: number | null;
  limitAlto: number | null;
}

export interface AlertEvent {
  id: number;
  type: 'opened' | 'reopened' | 'escalated' | 'breach' | 'recovered';
  ts: string;
  severity: Severity | null;
  valueKwh: number | null;
  expectedKwh: number | null;
  limitKwh: number | null;
  z: number | null;
  pctOver: number | null;
  excessKwh: number | null;
  explain: { reason?: string; window?: { name: string; dayType: string }; baseline?: { n: number; median: number; from: string; to: string }; persistence?: { required: number; observed: number }; rule?: string };
}

export interface AlertDetail {
  unit: UnitCode;
  alert: AlertItem;
  events: AlertEvent[];
  notifications: { id: number; status: string; createdAt: string; reason: string }[];
}

export interface NotificationRow {
  id: number;
  unitCode: UnitCode;
  kind: string;
  channel: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed';
  suppressReason: string | null;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
  alertCount: number;
}

export interface UnitConfigView {
  unit: UnitCode;
  name: string;
  timezone: string;
  intervalMin: number;
  tariffBrlPerKwh: number;
  windows: { key: string; name: string; startMin: number; endMin: number; dayType: string; thresholdMultiplier: number }[];
  rules: {
    version: string; lookbackDays: number; minBaselineSamples: number; recoveryReadings: number; reopenGraceMinutes: number;
    levels: Record<Severity, { z: number; pct: number; persistence: number }>;
    envelope: { quantile: number; tolerance: number };
    escalateAfterMinutes: { atencao: number; alto: number };
    minExcessKw: number;
  };
  policy: { notifyFrom: Severity; reminderMinutes: Record<Severity, number | null>; minExcessKwhToNotify: number; maxPerUnitPerHour: number; freshnessMinutes: number; notifyOnRecovery: boolean };
  notify: { configured: boolean; recipients: number; template: string };
  shadowMode: boolean;
}

export interface AuthState {
  authRequired: boolean;
  authenticated: boolean;
}
