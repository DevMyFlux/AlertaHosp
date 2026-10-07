// Backtest do motor V2 sobre dados reais exportados.
//
//   npx tsx scripts/replay.ts HCN backups/2026-10-07-pre-v2/hcn_tel.csv [dias=14]
//
// Imprime volume de incidentes/mensagens por dia e o recall com anomalias injetadas.
import { loadUnitFromCsv } from './lib/load.js';
import { replayUnit, summarizeReplay, type Injection } from './lib/replay.js';
import { isUnitCode } from '../core/units.js';

const [code, csv, daysArg] = process.argv.slice(2);
if (!isUnitCode(code) || !csv) throw new Error('uso: replay.ts <HCN|HMB> <csv> [dias]');
const days = Number(daysArg ?? 14);

const loaded = loadUnitFromCsv(code, csv);
const base = replayUnit(loaded, { days });
console.log(summarizeReplay(base, code));
console.log('  mensagens por dia:', Object.entries(base.perDay).map(([d, v]) => `${d.slice(5)}:${v.messages}`).join(' '));

// --- recall: injeta 4 anomalias sintéticas e verifica se cada uma gera mensagem ---
const monitored = loaded.unit.sectors.filter(s => s.monitored);
const stepMs = loaded.unit.expectedIntervalMin * 60000;
const lastTs = loaded.lastTs.getTime();
const picks = [
  { sector: monitored[0].code, factor: 1.6, readings: 6, label: '+60% por 6 leituras' },
  { sector: monitored[2].code, factor: 2.5, readings: 4, label: '+150% por 4 leituras' },
  { sector: monitored[4].code, factor: 1.35, readings: 12, label: '+35% por 12 leituras' },
  { sector: monitored[6].code, factor: 4, readings: 1, label: 'pico isolado ×4 (1 leitura)' },
];
// espaça as injeções em dias diferentes dentro da janela avaliada
const injections: (Injection & { label: string })[] = picks.map((p, i) => ({
  sectorCode: p.sector,
  startTs: new Date(lastTs - (days - 1 - i * 2) * 86400000 + 10 * 3600000),
  readings: p.readings,
  factor: p.factor,
  label: p.label,
}));
const withInj = replayUnit(loaded, { days, injections });
console.log('\nRecall com anomalias injetadas:');
for (const inj of injections) {
  const hit = withInj.incidents.find(
    i =>
      i.sectorCode === inj.sectorCode &&
      i.openedAt.getTime() >= inj.startTs.getTime() - stepMs &&
      i.openedAt.getTime() <= inj.startTs.getTime() + inj.readings * stepMs
  );
  const delayMin = hit?.notifiedAt ? Math.round((hit.notifiedAt.getTime() - inj.startTs.getTime()) / 60000) : null;
  console.log(
    `  ${inj.sectorCode.padEnd(24)} ${inj.label.padEnd(30)} → ${hit ? `incidente ${hit.peakSeverity}${hit.notifiedAt ? `, notificado após ${delayMin} min` : ', só no painel'}` : 'NÃO detectado'}`
  );
}
console.log(`  mensagens extras vs. base: ${withInj.messages.length - base.messages.length}`);
