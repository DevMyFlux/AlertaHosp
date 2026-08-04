import { sheetsConfigured, ensureTabExists, getValues, appendRow, batchUpdateValues } from './googleSheets.js';
import type { LoggedAlert } from '../../src/lib/alertLog.js';
import type { SectorAnomaly } from '../../src/lib/anomalyDetection.js';

// Equivalente server-side de src/lib/alertLog.ts, mas persistido numa aba
// própria da MESMA planilha de telemetria (em vez de localStorage, que só
// existe no navegador, ou de um banco separado tipo Redis) — pedido
// explícito do cliente pra não introduzir infra nova. Cada linha é um
// evento de anomalia disparada: enquanto `resolvedAt` estiver vazio, o setor
// está "ativo" (evita reenviar o mesmo alerta a cada execução do cron
// enquanto a anomalia persiste); quando o setor normaliza, preenchemos
// `resolvedAt` na mesma linha.
const TAB = 'EstadoAlertas';
const HEADER = ['sectorKey', 'band', 'loggedAt', 'resolvedAt'];

export const alertStoreConfigured = sheetsConfigured;

interface StoredRow {
  sectorKey: string;
  band: string;
  loggedAt: string;
  resolvedAt: string;
  rowNumber: number; // número da linha na planilha (1-based, já contando o cabeçalho)
}

let tabEnsured = false;

async function readRows(): Promise<StoredRow[]> {
  if (!sheetsConfigured) return [];
  if (!tabEnsured) {
    await ensureTabExists(TAB, HEADER);
    tabEnsured = true;
  }
  const values = await getValues(`${TAB}!A2:D`);
  return values
    .map((r, i) => ({
      sectorKey: r[0] ?? '',
      band: r[1] ?? '',
      loggedAt: r[2] ?? '',
      resolvedAt: r[3] ?? '',
      rowNumber: i + 2, // +2 porque a leitura começa em A2 (linha 1 é o cabeçalho)
    }))
    .filter(r => r.sectorKey);
}

// Setores que já dispararam alerta e ainda não voltaram ao normal — mesma
// função do `alertedSectorsRef` em App.tsx, só que persistida (o processo
// serverless não sobrevive entre chamadas do cron).
export async function getActiveSectors(): Promise<Set<string>> {
  const rows = await readRows();
  return new Set(rows.filter(r => !r.resolvedAt).map(r => r.sectorKey));
}

// Marca como resolvidas (preenche `resolvedAt`) as linhas ativas de setores
// que saíram da lista de "deve continuar ativo" — setores novos entram na
// planilha via recordAlert(), não aqui.
export async function setActiveSectors(sectorKeysThatShouldStayActive: string[]): Promise<void> {
  if (!sheetsConfigured) return;
  const wanted = new Set(sectorKeysThatShouldStayActive);
  const rows = await readRows();
  const toResolve = rows.filter(r => !r.resolvedAt && !wanted.has(r.sectorKey));
  if (toResolve.length === 0) return;

  const nowIso = new Date().toISOString();
  await batchUpdateValues(toResolve.map(r => ({
    range: `${TAB}!D${r.rowNumber}`,
    values: [[nowIso]],
  })));
}

// Registra um novo disparo de alerta (usado só para a estatística de
// "ocorreu N vezes nos últimos 30 dias" e para abrir a linha "ativa" desse
// setor).
export async function recordAlert(anomaly: Pick<SectorAnomaly, 'sectorKey' | 'band'>): Promise<void> {
  if (!sheetsConfigured) return;
  if (!tabEnsured) {
    await ensureTabExists(TAB, HEADER);
    tabEnsured = true;
  }
  await appendRow(TAB, [anomaly.sectorKey, anomaly.band, new Date().toISOString(), '']);
}

export async function getRecentAlerts(hoursAgo: number): Promise<Pick<LoggedAlert, 'sectorKey' | 'band'>[]> {
  const rows = await readRows();
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  return rows
    .filter(r => {
      const t = new Date(r.loggedAt).getTime();
      return !isNaN(t) && t >= cutoff;
    })
    .map(r => ({ sectorKey: r.sectorKey, band: r.band as LoggedAlert['band'] }));
}
