import { redis } from './kv.js';
import type { LoggedAlert } from '../../src/lib/alertLog.js';
import type { SectorAnomaly } from '../../src/lib/anomalyDetection.js';

// Equivalente server-side de src/lib/alertLog.ts, mas persistido num Redis
// (Upstash) em vez de localStorage — necessário porque /api/cron-check roda
// numa função serverless sem estado entre execuções e sem acesso a
// localStorage (que só existe no navegador). Sem isso, cada execução do
// cron re-enviaria o mesmo alerta do zero.
const LOG_KEY = 'alerts:log';
const ACTIVE_KEY = 'alerts:active';
const RETENTION_DAYS = 30;

// Setores que já dispararam alerta e ainda não voltaram ao normal — mesma
// função do `alertedSectorsRef` em App.tsx, só que persistida (o processo
// serverless não sobrevive entre chamadas do cron).
export async function getActiveSectors(): Promise<Set<string>> {
  if (!redis) return new Set();
  const members = await redis.smembers(ACTIVE_KEY);
  return new Set(members);
}

export async function setActiveSectors(sectorKeys: string[]): Promise<void> {
  if (!redis) return;
  await redis.del(ACTIVE_KEY);
  if (sectorKeys.length > 0) {
    await redis.sadd(ACTIVE_KEY, sectorKeys[0], ...sectorKeys.slice(1));
  }
}

// Registra um alerta no histórico (usado só para a estatística de
// "ocorreu N vezes nos últimos 30 dias" — o dedupe de reenvio em si é
// resolvido por getActiveSectors/setActiveSectors, chamado antes de
// recordAlert disparar).
export async function recordAlert(anomaly: SectorAnomaly): Promise<void> {
  if (!redis) return;
  const entry: LoggedAlert = { ...anomaly, loggedAt: new Date().toISOString() };
  await redis.zadd(LOG_KEY, { score: Date.now(), member: JSON.stringify(entry) });

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await redis.zremrangebyscore(LOG_KEY, 0, cutoff);
}

export async function getRecentAlerts(hoursAgo: number): Promise<LoggedAlert[]> {
  if (!redis) return [];
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const members = await redis.zrange<string[]>(LOG_KEY, cutoff, '+inf', { byScore: true });
  return members
    .map((raw) => {
      try {
        return JSON.parse(raw) as LoggedAlert;
      } catch {
        return null;
      }
    })
    .filter((v): v is LoggedAlert => v !== null);
}
