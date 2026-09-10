import {
  sheetsConfigured,
  getRows,
  appendRow,
  resolveSectors,
  defaultSheetsBridgeConfig,
  type SheetsBridgeConfig,
} from './sheetsBridge.js';
import type { LoggedAlert } from '../../src/lib/alertLog.js';
import type { SectorAnomaly } from '../../src/lib/anomalyDetection.js';

// Equivalente server-side de src/lib/alertLog.ts, mas persistido na aba
// "EstadoAlertas" de uma planilha de estado de alertas (via
// apps-script/Code.gs) em vez de localStorage — que só existe no navegador.
// Cada linha é um evento de anomalia disparada: enquanto `resolvedAt`
// estiver vazio, o setor está "ativo" (evita reenviar o mesmo alerta a cada
// execução do cron enquanto a anomalia persiste); quando o setor normaliza,
// a linha é marcada como resolvida.
//
// Multi-hospital: todas as funções aceitam um `SheetsBridgeConfig` opcional.
// Omitido = hospital atual (HCN), lido das env vars históricas — nenhum
// chamador anterior muda de comportamento.
export const alertStoreConfigured = sheetsConfigured;

/** true se a ponte de planilha do hospital atual (HCN) está configurada.
 *  Para outro hospital, teste o config resolvido (ver api/lib/hospitalRuntime). */
export { defaultSheetsBridgeConfig, type SheetsBridgeConfig };

// Setores que já dispararam alerta e ainda não voltaram ao normal — mesma
// função do `alertedSectorsRef` em App.tsx, só que persistida (o processo
// serverless não sobrevive entre chamadas do cron).
export async function getActiveSectors(
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<Set<string>> {
  const rows = await getRows(cfg);
  return new Set(rows.filter(r => !r.resolvedAt).map(r => r.sectorKey));
}

// Marca como resolvidas as linhas ativas de setores que saíram da lista de
// "deve continuar ativo" — setores novos entram na planilha via
// recordAlert(), não aqui.
export async function setActiveSectors(
  sectorKeysThatShouldStayActive: string[],
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<void> {
  if (!cfg) return;
  const wanted = new Set(sectorKeysThatShouldStayActive);
  const rows = await getRows(cfg);
  const toResolve = rows.filter(r => !r.resolvedAt && !wanted.has(r.sectorKey)).map(r => r.sectorKey);
  await resolveSectors(toResolve, cfg);
}

// Registra um novo disparo de alerta (usado pra estatística de "ocorreu N
// vezes nos últimos 30 dias", pra abrir a linha "ativa" desse setor, e —
// desde a adição de excedenteKwh/custoEstimadoBRL — pra guardar o consumo
// excedente e o custo financeiro daquele evento específico, permitindo
// somar/consultar por setor sem precisar reconstruir a partir da telemetria
// bruta.
export async function recordAlert(
  anomaly: Pick<SectorAnomaly, 'sectorKey' | 'band' | 'excedenteKwh' | 'custoEstimadoBRL'>,
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<void> {
  if (!cfg) return;
  await appendRow(anomaly.sectorKey, anomaly.band, anomaly.excedenteKwh, anomaly.custoEstimadoBRL, cfg);
}

export async function getRecentAlerts(
  hoursAgo: number,
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<Pick<LoggedAlert, 'sectorKey' | 'band'>[]> {
  const rows = await getRows(cfg);
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  return rows
    .filter(r => {
      const t = new Date(r.loggedAt).getTime();
      return !isNaN(t) && t >= cutoff;
    })
    .map(r => ({ sectorKey: r.sectorKey, band: r.band as LoggedAlert['band'] }));
}
