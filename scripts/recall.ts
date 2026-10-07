// Mapa de recall: injeta, em CADA setor, um aumento sustentado (N leituras) de
// +30%/+60%/+100%/+200% numa tarde de dia útil recente e mostra se o motor abre
// incidente (A=atenção, H=alto, C=crítico) e se notifica (*).
//
//   npx tsx scripts/recall.ts HMB backups/2026-10-07-antes-da-atualizacao/hmb_tel.csv [leituras=8]
import { loadUnitFromCsv } from './lib/load.js';
import { replayUnit, type Injection } from './lib/replay.js';
import { isUnitCode } from '../core/units.js';
import { localParts } from '../core/time.js';

const [code, csv, nArg] = process.argv.slice(2);
if (!isUnitCode(code) || !csv) throw new Error('uso: recall.ts <HCN|HMB> <csv> [leituras]');
const readings = Number(nArg ?? 8);
const factors = [1.3, 1.6, 2, 3];

const loaded = loadUnitFromCsv(code, csv);
const { unit } = loaded;
const stepMs = unit.expectedIntervalMin * 60000;
const monitored = unit.sectors.filter(s => s.monitored);

// último dia útil completo com pelo menos 2 dias de folga, às 14:00 locais
let day = new Date(loaded.lastTs.getTime() - 3 * 86400000);
for (let i = 0; i < 7; i++) {
  const p = localParts(day, unit.timezone);
  if (p.weekday >= 1 && p.weekday <= 5) break;
  day = new Date(day.getTime() - 86400000);
}
const p = localParts(day, unit.timezone);
const start = new Date(Date.UTC(p.year, p.month - 1, p.day, 14 + 3, 0, 0)); // 14:00 BRT = 17:00Z

console.log(`${code}: injeção de ${readings} leituras (${(readings * unit.expectedIntervalMin) / 60} h) em ${p.dateKey} 14:00 locais\n`);
const header = 'Setor'.padEnd(26) + factors.map(f => `×${f}`.padStart(7)).join('');
console.log(header);

const results = new Map<string, string[]>();
for (const s of monitored) results.set(s.code, []);
for (const factor of factors) {
  const injections: Injection[] = monitored.map(s => ({ sectorCode: s.code, startTs: start, readings, factor }));
  const res = replayUnit(loaded, { days: 5, injections });
  for (const s of monitored) {
    const hit = res.incidents.find(
      i => i.sectorCode === s.code && i.openedAt.getTime() >= start.getTime() - stepMs && i.openedAt.getTime() <= start.getTime() + (readings + 1) * stepMs
    );
    const tag = !hit ? '—' : `${hit.peakSeverity === 'critico' ? 'C' : hit.peakSeverity === 'alto' ? 'H' : 'A'}${hit.notifiedAt ? '*' : ''}`;
    results.get(s.code)!.push(tag);
  }
}
for (const s of monitored) console.log(s.name.padEnd(26) + results.get(s.code)!.map(t => t.padStart(7)).join(''));
console.log('\nA=atenção (só painel)  H=alto  C=crítico  *=gerou WhatsApp  —=não detectado');
