// Utilitários de tempo com fuso horário explícito.
//
// A telemetria chega com `E3TimeStamp` em horário local do hospital, sem
// offset ("2026-09-24 16:45:00"). A V1 interpretava isso no fuso do processo
// (UTC na Vercel, local no navegador). Aqui o fuso é sempre explícito.

export type DayType = 'weekday' | 'weekend';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** minutos desde 00:00 local (0–1439) */
  minuteOfDay: number;
  /** 0 = domingo … 6 = sábado */
  weekday: number;
  /** "YYYY-MM-DD" local */
  dateKey: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    minuteOfDay: hour * 60 + minute,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Diferença (local − UTC) em ms para o instante dado. */
function offsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const ABSOLUTE_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Converte um timestamp textual em instante UTC. Strings sem offset são
 * interpretadas no `timeZone` informado; strings com `Z`/offset são absolutas.
 * Devolve `null` se não for uma data válida.
 */
export function parseTimestamp(input: string, timeZone: string): Date | null {
  const s = String(input ?? '').trim();
  if (!s) return null;

  if (ABSOLUTE_RE.test(s) && s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const [yy, mm, dd, hh, mn, ss] = [y, mo, d, h, mi, se ?? '0'].map(Number);
  // Date.UTC "rola" componentes fora de faixa (mês 13 vira janeiro do ano seguinte) — rejeitamos antes.
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth || hh > 23 || mn > 59 || ss > 59) return null;
  const guess = Date.UTC(yy, mm - 1, dd, hh, mn, ss);
  // Duas passadas cobrem as bordas de horário de verão.
  let utc = guess - offsetMs(guess, timeZone);
  utc = guess - offsetMs(utc, timeZone);
  const result = new Date(utc);
  return Number.isNaN(result.getTime()) ? null : result;
}

export function dayTypeOf(weekday: number): DayType {
  return weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
}

const WEEKDAY_NAMES_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function weekdayNamePt(weekday: number): string {
  return WEEKDAY_NAMES_PT[weekday] ?? '';
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}
