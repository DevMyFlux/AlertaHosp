// Metadados de identidade das unidades — sem dados operacionais, seguros para ir ao navegador.
export const UNIT_CODES = ['HCN', 'HMB'] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

export const UNIT_META: Record<UnitCode, { name: string; accent: string; accentDark: string }> = {
  HCN: { name: 'HCN', accent: '#2563EB', accentDark: '#60A5FA' },
  HMB: { name: 'HMB', accent: '#0F766E', accentDark: '#2DD4BF' },
};

export function isUnitCode(value: unknown): value is UnitCode {
  return typeof value === 'string' && (UNIT_CODES as readonly string[]).includes(value);
}
