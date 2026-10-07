// Simulador de uma unidade: gera a "planilha" (contadores acumulados em pt-BR,
// mais recente no topo) e permite injetar os problemas reais do campo —
// reinício da fonte, lacunas, atraso, anomalias de consumo — de forma
// determinística (PRNG com semente).
import type { TelemetrySource, DigestMessage, Notifier, NotifierDescription, SendOutcome } from '../backend/infra/ports.js';
import type { UnitCode, UnitDef } from '../core/units.js';
import { UNITS } from '../core/units.js';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC → "YYYY-MM-DD HH:MM:SS" no horário de São Paulo (UTC−3, sem horário de verão desde 2019) */
export function localSheetTimestamp(utc: Date): string {
  const d = new Date(utc.getTime() - 3 * 3600000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export interface TickOptions {
  /** multiplica o consumo do setor neste intervalo (anomalia) */
  factor?: Record<string, number>;
  /** linha do reinício: contadores "-"/0 (e um setor com outro contador), qualidade ainda 192 */
  restart?: boolean;
  /** quando true o intervalo passa, mas a linha NÃO é publicada (fonte fora do ar) */
  unpublished?: boolean;
}

export class SimSource implements TelemetrySource {
  readonly rows: { ts: Date; row: Record<string, string> }[] = [];
  now: Date;
  private readonly counters = new Map<string, number>();
  private readonly base = new Map<string, number>();
  private readonly rand: () => number;

  constructor(readonly unit: UnitDef, start: Date, seed = 1) {
    this.now = start;
    this.rand = mulberry32(seed);
    unit.sectors.forEach((s, i) => {
      this.counters.set(s.code, 100000 + i * 5000);
      this.base.set(s.code, (4 + (i % 5) * 3) * (unit.expectedIntervalMin / 15));
    });
  }

  private consumption(code: string, factor: number): number {
    const p = new Date(this.now.getTime() - 3 * 3600000);
    const hour = p.getUTCHours() + p.getUTCMinutes() / 60;
    const pattern = 1 + 0.25 * Math.sin((2 * Math.PI * (hour - 8)) / 24);
    const noise = 1 + (this.rand() - 0.5) * 0.12;
    return Math.round(this.base.get(code)! * pattern * noise * factor * 1000) / 1000;
  }

  tick(opts: TickOptions = {}): Date {
    this.now = new Date(this.now.getTime() + this.unit.expectedIntervalMin * 60000);
    const row: Record<string, string> = { E3TimeStamp: localSheetTimestamp(this.now) };
    for (const s of this.unit.sectors) {
      const next = (this.counters.get(s.code) ?? 0) + this.consumption(s.code, opts.factor?.[s.code] ?? 1);
      this.counters.set(s.code, next);
      let text = next.toFixed(3).replace('.', ',');
      if (opts.restart) text = s.code === this.unit.sectors[3].code ? '24710,902' : this.rand() > 0.5 ? '-' : '0';
      row[s.sourceColumn] = text;
      row[`${s.sourceColumn}_Quality`] = '192';
    }
    if (!opts.unpublished) this.rows.push({ ts: this.now, row });
    return this.now;
  }

  ticks(n: number, opts: TickOptions = {}) {
    for (let i = 0; i < n; i++) this.tick(opts);
  }

  async fetchRows(_unit: UnitDef, limit: number | 'all'): Promise<Record<string, string>[]> {
    const newestFirst = [...this.rows].reverse().map(r => r.row);
    return limit === 'all' ? newestFirst : newestFirst.slice(0, limit);
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: DigestMessage[] = [];
  failNext = 0;
  configured = true;

  describe(unitCode: UnitCode): NotifierDescription {
    return { problem: this.configured ? null : 'sem destinatários', recipientsMasked: ['*********0001'], template: `tpl_${unitCode}` };
  }

  async sendDigest(message: DigestMessage): Promise<SendOutcome> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, results: [{ recipientMasked: '*********0001', status: 'error', error: 'Vonage 1020' }], error: 'Nenhum destinatário recebeu a mensagem' };
    }
    this.sent.push(message);
    return { ok: true, results: [{ recipientMasked: '*********0001', status: 'success', channel: 'whatsapp', template: `tpl_${message.unitCode}` }] };
  }

  async sendTest(unitCode: UnitCode, text: string): Promise<SendOutcome> {
    return this.sendDigest({ unitCode, params: [text], smsText: text, sectorLabel: 'teste', valueLabel: '0' });
  }
}

export { UNITS };
