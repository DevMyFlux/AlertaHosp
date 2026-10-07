// Faixas operacionais configuráveis.
//
// O consumo hospitalar muda ao longo do dia (madrugada, troca de turno,
// refeições). Cada faixa tem o seu próprio baseline — comparar o consumo das
// 03h com o das 13h gera falso positivo estrutural, exatamente o que a V1
// fazia com a faixa "Demais Horários" (13 horas misturadas).
//
// As faixas vivem no banco (`operational_windows`, editáveis por unidade).
// `DEFAULT_WINDOWS` é só o seed inicial e o padrão de testes/replay —
// calibrado com a curva de carga real do HCN e do HMB (ver docs/02).

import { dayTypeOf, localParts, type DayType } from '../time.js';
import type { WindowDayType } from './types.js';

export interface OperationalWindow {
  /** identificador estável usado nas chaves de baseline */
  key: string;
  name: string;
  /** minutos desde 00:00 local, início inclusivo */
  startMin: number;
  /** minutos desde 00:00 local, fim exclusivo (até 1440) */
  endMin: number;
  dayType: WindowDayType;
  /** >1 torna a faixa menos sensível (ex.: troca de turno); <1 mais sensível */
  thresholdMultiplier: number;
}

const w = (key: string, name: string, from: string, to: string, thresholdMultiplier = 1): OperationalWindow => {
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return { key, name, startMin: toMin(from), endMin: to === '24:00' ? 1440 : toMin(to), dayType: 'all', thresholdMultiplier };
};

/** Seed padrão — a mesma estrutura para HCN e HMB; cada unidade pode divergir no banco. */
export const DEFAULT_WINDOWS: readonly OperationalWindow[] = [
  w('madrugada', 'Madrugada', '00:00', '06:00'),
  w('turno_manha', 'Troca de turno (manhã)', '06:00', '08:00', 1.15),
  w('manha', 'Manhã', '08:00', '11:00'),
  w('almoco', 'Almoço', '11:00', '14:00'),
  w('tarde', 'Tarde', '14:00', '18:00'),
  w('turno_noite', 'Troca de turno e jantar', '18:00', '21:00', 1.15),
  w('noite', 'Noite', '21:00', '24:00'),
];

/**
 * Faixa a que uma leitura pertence. A leitura de 07:00 representa o consumo de
 * 06:45–07:00, então usamos o ponto médio do intervalo (ts − intervalo/2) —
 * a V1 usava a hora cheia do carimbo e deslocava toda a curva em um intervalo.
 */
export function windowFor(
  windows: readonly OperationalWindow[],
  ts: Date,
  intervalMin: number,
  timeZone: string
): { window: OperationalWindow; dayType: DayType } | null {
  const mid = new Date(ts.getTime() - (intervalMin * 60000) / 2);
  const p = localParts(mid, timeZone);
  const dayType = dayTypeOf(p.weekday);
  const found = windows.find(
    win =>
      p.minuteOfDay >= win.startMin &&
      p.minuteOfDay < win.endMin &&
      (win.dayType === 'all' || win.dayType === dayType)
  );
  return found ? { window: found, dayType } : null;
}

/** Valida cobertura: cada minuto do dia pertence a exatamente uma faixa para cada tipo de dia. */
export function validateWindows(windows: readonly OperationalWindow[]): string[] {
  const problems: string[] = [];
  for (const dayType of ['weekday', 'weekend'] as const) {
    const owner: (string | null)[] = new Array(1440).fill(null);
    for (const win of windows) {
      if (win.dayType !== 'all' && win.dayType !== dayType) continue;
      if (win.startMin < 0 || win.endMin > 1440 || win.startMin >= win.endMin) {
        problems.push(`faixa "${win.name}" tem limites inválidos (${win.startMin}–${win.endMin})`);
        continue;
      }
      for (let m = win.startMin; m < win.endMin; m++) {
        if (owner[m]) {
          problems.push(`${dayType}: "${win.name}" sobrepõe "${owner[m]}" às ${Math.floor(m / 60)}h`);
          break;
        }
        owner[m] = win.name;
      }
    }
    const firstGap = owner.indexOf(null);
    if (firstGap !== -1) problems.push(`${dayType}: nenhuma faixa cobre ${String(Math.floor(firstGap / 60)).padStart(2, '0')}:${String(firstGap % 60).padStart(2, '0')}`);
  }
  return problems;
}
