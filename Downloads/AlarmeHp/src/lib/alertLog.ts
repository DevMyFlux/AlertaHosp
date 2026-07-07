import { SectorAnomaly } from './anomalyDetection';

export interface LoggedAlert extends SectorAnomaly {
  loggedAt: string;
}

const STORAGE_KEY = 'alert_log';
const MAX_ENTRIES = 500;
const RETENTION_DAYS = 30;

function readLog(): LoggedAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(entries: LoggedAlert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    console.warn('Não foi possível salvar o histórico de alertas:', e);
  }
}

// Registra um alerta detectado no histórico local (por navegador), evitando
// duplicar a mesma ocorrência (mesmo setor + horário do dado de telemetria).
export function logAlert(anomaly: SectorAnomaly): void {
  const entries = readLog();
  const alreadyLogged = entries.some(
    e => e.sectorKey === anomaly.sectorKey && e.time === anomaly.time && e.date === anomaly.date
  );
  if (alreadyLogged) return;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruned = entries.filter(e => new Date(e.loggedAt).getTime() >= cutoff);

  pruned.push({ ...anomaly, loggedAt: new Date().toISOString() });
  writeLog(pruned.slice(-MAX_ENTRIES));
}

export function getAlertLog(): LoggedAlert[] {
  return readLog();
}

// Retorna os alertas registrados nas últimas `hoursAgo` horas (a partir de
// quando cada um foi de fato detectado, não do horário do dado em si).
export function getAlertLogSince(hoursAgo: number): LoggedAlert[] {
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  return readLog().filter(e => new Date(e.loggedAt).getTime() >= cutoff);
}
