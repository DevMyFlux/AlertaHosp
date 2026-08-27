// Ponte com a aba "EstadoAlertas" da planilha de telemetria, via um Web App
// do Google Apps Script preso à própria planilha (Extensões > Apps Script)
// — ver apps-script/Code.gs. Escolhido no lugar de uma Service Account +
// Google Sheets API (OAuth) porque o Apps Script não exige Google Cloud
// Console, chave JSON nem passo de compartilhamento: o script já roda como
// o dono da planilha. O mesmo Web App também tem o gatilho de tempo que
// chama /api/cron-check a cada 15 min, substituindo a necessidade de um
// pinger externo (cron-job.org) no plano Free da Vercel.
const WEBAPP_URL = process.env.SHEETS_WEBAPP_URL;
const SHARED_SECRET = process.env.CRON_SECRET;

export const sheetsConfigured = Boolean(WEBAPP_URL && SHARED_SECRET);

export interface RemoteRow {
  sectorKey: string;
  band: string;
  loggedAt: string;
  resolvedAt: string;
  excedenteKwh: number;
  custoGeradoBRL: number;
}

async function callGet(): Promise<RemoteRow[]> {
  const url = `${WEBAPP_URL}?secret=${encodeURIComponent(SHARED_SECRET!)}&action=list`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apps Script Web App HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { rows?: RemoteRow[]; error?: string };
  if (data.error) throw new Error(`Apps Script Web App: ${data.error}`);
  return data.rows || [];
}

async function callPost(body: unknown): Promise<void> {
  const url = `${WEBAPP_URL}?secret=${encodeURIComponent(SHARED_SECRET!)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apps Script Web App HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (data.error) throw new Error(`Apps Script Web App: ${data.error}`);
}

export async function getRows(): Promise<RemoteRow[]> {
  if (!sheetsConfigured) return [];
  return callGet();
}

export async function appendRow(
  sectorKey: string,
  band: string,
  excedenteKwh: number,
  custoGeradoBRL: number
): Promise<void> {
  if (!sheetsConfigured) return;
  await callPost({ action: 'append', sectorKey, band, excedenteKwh, custoGeradoBRL });
}

export async function resolveSectors(sectorKeys: string[]): Promise<void> {
  if (!sheetsConfigured || sectorKeys.length === 0) return;
  await callPost({ action: 'resolve', sectorKeys });
}
