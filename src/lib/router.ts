// Roteador mínimo por hash: a unidade SEMPRE faz parte do endereço (#/HCN/alertas).
// Assim um link compartilhado, o botão "voltar" e a aba aberta nunca deixam dúvida
// de qual hospital está na tela.
import { useEffect, useState } from 'react';
import { isUnitCode, type UnitCode } from '../../core/unitMeta';

export type PageKey = 'overview' | 'sectors' | 'alerts' | 'settings';

export interface Route {
  unit: UnitCode;
  page: PageKey;
  /** id do alerta na página de detalhe */
  alertId: number | null;
  /** setor aberto na página de setores */
  sector: string | null;
}

const PAGES: Record<string, PageKey> = { visao: 'overview', setores: 'sectors', alertas: 'alerts', configuracoes: 'settings' };
export const PAGE_SLUG: Record<PageKey, string> = { overview: 'visao', sectors: 'setores', alerts: 'alertas', settings: 'configuracoes' };

const LAST_UNIT_KEY = 'ultima_unidade';

function lastUnit(): UnitCode {
  try {
    const v = localStorage.getItem(LAST_UNIT_KEY);
    if (isUnitCode(v)) return v;
  } catch {
    /* armazenamento indisponível */
  }
  return 'HCN';
}

export function parseHash(hash: string): Route {
  const [unitRaw, pageRaw, extra] = hash.replace(/^#\/?/, '').split(/[/?]/);
  const unit = isUnitCode(unitRaw?.toUpperCase()) ? (unitRaw.toUpperCase() as UnitCode) : lastUnit();
  const page = PAGES[pageRaw] ?? 'overview';
  const id = page === 'alerts' && extra && /^\d+$/.test(extra) ? Number(extra) : null;
  const sector = page === 'sectors' && extra ? decodeURIComponent(extra) : null;
  return { unit, page, alertId: id, sector };
}

export function href(unit: UnitCode, page: PageKey, extra?: string | number): string {
  return `#/${unit}/${PAGE_SLUG[page]}${extra !== undefined ? `/${encodeURIComponent(String(extra))}` : ''}`;
}

export function navigate(unit: UnitCode, page: PageKey, extra?: string | number): void {
  window.location.hash = href(unit, page, extra);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    // endereço sem unidade/página → normaliza para #/HCN/visao
    if (!/^#\/(HCN|HMB)\//i.test(window.location.hash)) {
      const r = parseHash(window.location.hash);
      window.location.replace(href(r.unit, r.page));
    }
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAST_UNIT_KEY, route.unit);
    } catch {
      /* ignora */
    }
  }, [route.unit]);
  return route;
}
