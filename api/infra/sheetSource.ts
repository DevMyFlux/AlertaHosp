// Fonte de telemetria: aba pública da planilha Google (exportada como CSV).
//
// Para não baixar a planilha inteira (3,4 MB / 9 mil linhas e crescendo) a cada
// ciclo, usa o endpoint `gviz` com `select * limit N`: como o script da máquina
// física insere no topo, as N primeiras linhas são as N mais recentes
// (~600 B/linha em vez de 3,4 MB). Se falhar, cai para o CSV completo.

import Papa from 'papaparse';
import type { TelemetrySource } from './ports.js';
import type { UnitDef } from '../../core/units.js';

export function gvizUrl(csvExportUrl: string, limit: number): string {
  const m = /^(https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+)\/export\?(.*)$/.exec(csvExportUrl);
  if (!m) throw new Error('URL de planilha em formato inesperado');
  const params = new URLSearchParams(m[2]);
  const gid = params.get('gid') ?? '0';
  const query = encodeURIComponent(`select * limit ${Math.max(1, Math.floor(limit))}`);
  return `${m[1]}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}&tq=${query}`;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function getText(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

export class SheetTelemetrySource implements TelemetrySource {
  constructor(
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 20_000
  ) {}

  async fetchRows(unit: UnitDef, limit: number | 'all'): Promise<Record<string, string>[]> {
    if (!unit.sheetCsvUrl) throw new Error(`Unidade ${unit.code} sem planilha de telemetria configurada`);
    if (limit !== 'all') {
      try {
        const rows = parseCsv(await getText(this.fetchFn, gvizUrl(unit.sheetCsvUrl, limit), this.timeoutMs));
        // resposta sem a coluna de timestamp = erro da API devolvido como "CSV"
        if (rows.length > 0 && 'E3TimeStamp' in rows[0]) return rows;
      } catch {
        // cai para o CSV completo abaixo
      }
    }
    return parseCsv(await getText(this.fetchFn, unit.sheetCsvUrl, this.timeoutMs * 2));
  }
}
