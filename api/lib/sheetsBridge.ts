// Ponte com a aba "EstadoAlertas" de uma planilha de estado de alertas, via
// um Web App do Google Apps Script preso à própria planilha (Extensões >
// Apps Script) — ver apps-script/Code.gs (HCN) e apps-script/Code_HMB.gs
// (HMB). Escolhido no lugar de uma Service Account + Google Sheets API
// (OAuth) porque o Apps Script não exige Google Cloud Console, chave JSON
// nem passo de compartilhamento: o script já roda como o dono da planilha.
//
// Multi-hospital: cada hospital tem a SUA planilha de estado, o SEU Web App
// e o SEU segredo. As funções abaixo aceitam um `SheetsBridgeConfig`
// opcional; quando omitido, caem na configuração do hospital atual (HCN),
// lida das env vars SHEETS_WEBAPP_URL / CRON_SECRET — exatamente o
// comportamento anterior, então nenhum chamador que não passa config muda.
export interface SheetsBridgeConfig {
  /** URL do Web App do Apps Script (termina em /exec). */
  webappUrl: string;
  /** Segredo compartilhado com esse Apps Script (querystring `secret`). */
  secret: string;
}

/** Config do hospital atual (HCN) a partir das env vars históricas. `null`
 *  quando não configurado — mantém a semântica de `sheetsConfigured`. */
export function defaultSheetsBridgeConfig(): SheetsBridgeConfig | null {
  const webappUrl = process.env.SHEETS_WEBAPP_URL;
  const secret = process.env.CRON_SECRET;
  return webappUrl && secret ? { webappUrl, secret } : null;
}

// Mantido com o mesmo nome e sentido de antes: "o hospital atual tem a ponte
// de planilha configurada?". Quem precisa saber de outro hospital resolve
// via defaultSheetsBridgeConfig()/config próprio.
export const sheetsConfigured = Boolean(defaultSheetsBridgeConfig());

export interface RemoteRow {
  sectorKey: string;
  band: string;
  loggedAt: string;
  resolvedAt: string;
  excedenteKwh: number;
  custoGeradoBRL: number;
}

async function callGet(cfg: SheetsBridgeConfig): Promise<RemoteRow[]> {
  const url = `${cfg.webappUrl}?secret=${encodeURIComponent(cfg.secret)}&action=list`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apps Script Web App HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { rows?: RemoteRow[]; error?: string };
  if (data.error) throw new Error(`Apps Script Web App: ${data.error}`);
  return data.rows || [];
}

async function callPost(cfg: SheetsBridgeConfig, body: unknown): Promise<void> {
  const url = `${cfg.webappUrl}?secret=${encodeURIComponent(cfg.secret)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apps Script Web App HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (data.error) throw new Error(`Apps Script Web App: ${data.error}`);
}

export async function getRows(
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<RemoteRow[]> {
  if (!cfg) return [];
  return callGet(cfg);
}

export async function appendRow(
  sectorKey: string,
  band: string,
  excedenteKwh: number,
  custoGeradoBRL: number,
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<void> {
  if (!cfg) return;
  await callPost(cfg, { action: 'append', sectorKey, band, excedenteKwh, custoGeradoBRL });
}

export async function resolveSectors(
  sectorKeys: string[],
  cfg: SheetsBridgeConfig | null = defaultSheetsBridgeConfig()
): Promise<void> {
  if (!cfg || sectorKeys.length === 0) return;
  await callPost(cfg, { action: 'resolve', sectorKeys });
}
