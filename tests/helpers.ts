import type { RawSample } from '../core/telemetry/parse.js';

/** Origem fixa (UTC) — suficiente para os testes de domínio. */
export const T0 = Date.UTC(2026, 8, 24, 12, 0, 0); // 2026-09-24T12:00:00Z

export function at(minutes: number): Date {
  return new Date(T0 + minutes * 60000);
}

type Cell = number | null | [number | null, number | null]; // valor | [valor, qualidade]

/**
 * Monta amostras: `rows[i][sector]` = valor (qualidade 192) ou [valor, qualidade].
 * `minutes[i]` = instante da amostra i, em minutos desde T0.
 */
export function makeSamples(minutes: number[], rows: Record<string, Cell>[]): RawSample[] {
  return rows.map((row, i) => {
    const values: RawSample['values'] = {};
    for (const [code, cell] of Object.entries(row)) {
      if (Array.isArray(cell)) values[code] = { counter: cell[0], quality: cell[1] };
      else values[code] = { counter: cell, quality: 192 };
    }
    return { ts: at(minutes[i]), values };
  });
}

/** 0, step, 2·step, … (n pontos) */
export function every(step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => i * step);
}

// ---------------------------------------------------------------------------
// Fábrica de avaliações para testar ciclo de vida/política sem depender de baseline.
import type { Evaluation } from '../core/alerts/detector.js';
import type { Level } from '../core/alerts/types.js';

export function evaluation(level: Level, over: Partial<Evaluation> = {}): Evaluation {
  const expected = over.expected ?? 10;
  const value = over.value ?? (level === 'normal' ? expected : expected * 2);
  return {
    level,
    value,
    expected,
    sigma: 1,
    z: (value - expected) / 1,
    pctOver: (value - expected) / expected,
    excessKwh: Math.max(0, value - expected),
    limits: { atencao: 12, alto: 15, critico: 20 },
    envelope: 12,
    binding: { atencao: 'z', alto: 'z', critico: 'z' },
    windowKey: 'tarde',
    windowName: 'Tarde',
    dayType: 'weekday',
    baseline: { windowKey: 'tarde', dayType: 'weekday', n: 100, median: expected, sigmaRaw: 1, p99: 12, quantum: 0, from: '2026-09-01T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z' },
    rulesVersion: 'test',
    ...over,
  };
}

/** Extrai o texto de um PDF gerado SEM compressão (pdfkit codifica o texto em hexadecimal WinAnsi). */
export function pdfText(buf: Buffer): string[] {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = '';
    for (const h of m[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
      line += Buffer.from(h[1], 'hex').toString('latin1').replace(/\x97/g, '—').replace(/\x96/g, '–').replace(/\x95/g, '•');
    }
    out.push(line);
  }
  return out;
}
