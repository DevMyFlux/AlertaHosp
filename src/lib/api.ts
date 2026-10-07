// Cliente da API. Toda rota de dados é por unidade — não há chamada "global".
import type { UnitCode } from '../../core/unitMeta';
import type { AlertDetail, AlertItem, AuthState, NotificationRow, Overview, SectorSnapshot, SeriesPoint, UnitConfigView, UnitInfo } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Sem conexão com o servidor');
  }
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* corpo não é JSON */
    }
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  auth: {
    me: (signal?: AbortSignal) => request<AuthState>('/api/auth/me', {}, signal),
    login: (password: string) =>
      request<{ authenticated: boolean }>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }),
    logout: () => request<{ authenticated: boolean }>('/api/auth/logout', { method: 'POST' }),
  },
  units: (signal?: AbortSignal) => request<{ units: UnitInfo[] }>('/api/units', {}, signal),
  overview: (unit: UnitCode, days: number, signal?: AbortSignal) => request<Overview>(`/api/units/${unit}/overview${qs({ days })}`, {}, signal),
  sectors: (unit: UnitCode, signal?: AbortSignal) => request<{ unit: UnitCode; sectors: SectorSnapshot[] }>(`/api/units/${unit}/sectors`, {}, signal),
  series: (unit: UnitCode, sector: string, opts: { hours?: number; from?: string; to?: string }, signal?: AbortSignal) =>
    request<{ unit: UnitCode; sector: { code: string; name: string }; intervalMin: number; timezone: string; points: SeriesPoint[] }>(
      `/api/units/${unit}/sectors/${encodeURIComponent(sector)}/series${qs(opts)}`,
      {},
      signal
    ),
  alerts: (
    unit: UnitCode,
    filter: { from?: string; to?: string; status?: string; severity?: string; sector?: string; limit?: number; offset?: number; includeSuspect?: boolean },
    signal?: AbortSignal
  ) => request<{ unit: UnitCode; items: AlertItem[]; total: number }>(`/api/units/${unit}/alerts${qs({ ...filter, includeSuspect: filter.includeSuspect ? 'true' : undefined })}`, {}, signal),
  alert: (unit: UnitCode, id: number, signal?: AbortSignal) => request<AlertDetail>(`/api/units/${unit}/alerts/${id}`, {}, signal),
  notifications: (unit: UnitCode, signal?: AbortSignal) => request<{ unit: UnitCode; notifications: NotificationRow[] }>(`/api/units/${unit}/notifications?limit=20`, {}, signal),
  config: (unit: UnitCode, signal?: AbortSignal) => request<UnitConfigView>(`/api/units/${unit}/config`, {}, signal),
  testNotification: (unit: UnitCode) => request<{ ok: boolean }>(`/api/units/${unit}/notifications/test`, { method: 'POST' }),
};

/** URL do relatório (download direto pelo navegador). `units` sempre explícito. */
export function reportUrl(units: UnitCode[], format: 'xlsx' | 'pdf', from: string, to: string): string {
  return `/api/reports/alerts${qs({ unit: units.join(','), format, from, to })}`;
}
