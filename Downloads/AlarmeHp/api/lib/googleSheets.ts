import jwt from 'jsonwebtoken';

// Mesma planilha usada como fonte de telemetria (ver src/config/sheet.ts) —
// extraído do SHEET_URL. Reaproveitada como armazenamento de estado do cron
// (numa aba própria) em vez de um banco separado (Redis/Upstash), a pedido
// explícito do cliente: menos infra nova pra manter, tudo numa planilha que
// a equipe já usa e entende.
const SPREADSHEET_ID = '15BmawHMQ6ucZJwe5jqksRw2ZSW55R4IszgnmbTTYWGs';

const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const rawPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

// A planilha precisa estar compartilhada com esse e-mail de service account
// (permissão de Editor, não só Leitor — o cron escreve nela) pra qualquer
// operação abaixo funcionar. Ver .env.example pra instruções completas.
export const sheetsConfigured = Boolean(serviceAccountEmail && rawPrivateKey);

let cachedToken: { token: string; expiresAt: number } | null = null;

// Troca a chave privada da service account por um access token OAuth2 de
// curta duração (fluxo "JWT Bearer" do Google, sem precisar da SDK oficial
// googleapis/google-auth-library — só jsonwebtoken, que o projeto já usa
// pra outra coisa). Cacheado em memória do processo pra não re-autenticar a
// cada leitura/escrita dentro da mesma execução do cron.
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const privateKey = rawPrivateKey!.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' }
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    throw new Error(`Falha ao autenticar com a Google Service Account: HTTP ${res.status} - ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function sheetsFetch(path: string, init?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Google Sheets API HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Cria a aba (com cabeçalho) na primeira vez que for usada, se ainda não
// existir — evita depender de alguém criar a aba manualmente com o nome e
// colunas certos.
export async function ensureTabExists(tabName: string, header: string[]): Promise<void> {
  const meta = await sheetsFetch('?fields=sheets.properties.title');
  const exists = (meta.sheets || []).some((s: any) => s.properties?.title === tabName);
  if (exists) return;

  await sheetsFetch(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });
  await sheetsFetch(`/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW`, {
    method: 'POST',
    body: JSON.stringify({ values: [header] }),
  });
}

export async function getValues(range: string): Promise<string[][]> {
  const data = await sheetsFetch(`/values/${encodeURIComponent(range)}`);
  return data.values || [];
}

export async function appendRow(tabName: string, row: (string | number)[]): Promise<void> {
  await sheetsFetch(`/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
}

// Atualiza várias células isoladas (ex: coluna "resolvedAt" de várias linhas
// diferentes) numa única chamada, em vez de uma requisição PUT por linha.
export async function batchUpdateValues(updates: { range: string; values: (string | number)[][] }[]): Promise<void> {
  if (updates.length === 0) return;
  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: updates.map(u => ({ range: u.range, values: u.values })),
    }),
  });
}
