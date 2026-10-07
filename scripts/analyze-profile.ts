// Análise exploratória dos dados reais: perfil por hora, variabilidade por setor
// e qualidade. Serve para escolher faixas operacionais e parâmetros do motor
// com base em evidência, não em palpite.
//
//   npx tsx scripts/analyze-profile.ts HCN backups/2026-10-07-pre-v2/hcn_tel.csv
import { loadUnitFromCsv } from './lib/load.js';
import { isBaselineEligible } from '../core/telemetry/normalize.js';
import { localParts, dayTypeOf } from '../core/time.js';
import { summarize, median } from '../core/stats.js';
import { isUnitCode } from '../core/units.js';

const [code, csv] = process.argv.slice(2);
if (!isUnitCode(code) || !csv) throw new Error('uso: analyze-profile.ts <HCN|HMB> <csv>');

const loaded = loadUnitFromCsv(code, csv);
const { unit } = loaded;
console.log(`${code}: ${loaded.sampleCount} amostras ${loaded.firstTs.toISOString()} → ${loaded.lastTs.toISOString()}`);
console.log(`eventos de fonte: ${loaded.events.length}`, loaded.events.map(e => `${e.ts.toISOString().slice(0, 16)}(${e.affectedSectors})`).join(' '));

const status: Record<string, number> = {};
for (const r of loaded.readings) status[r.status] = (status[r.status] ?? 0) + 1;
console.log('status das leituras:', status);

// perfil por hora do dia (dias úteis), somando os setores monitorados por timestamp
const byTs = new Map<number, { sum: number; n: number; hour: number; weekend: boolean }>();
const monitored = new Set(unit.sectors.filter(s => s.monitored).map(s => s.code));
for (const r of loaded.readings) {
  if (!monitored.has(r.sectorCode) || !isBaselineEligible(r)) continue;
  const p = localParts(r.ts, unit.timezone);
  const k = r.ts.getTime();
  const e = byTs.get(k) ?? { sum: 0, n: 0, hour: p.hour, weekend: dayTypeOf(p.weekday) === 'weekend' };
  e.sum += r.intervalKwh ?? 0;
  e.n++;
  byTs.set(k, e);
}
for (const weekend of [false, true]) {
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const e of byTs.values()) if (e.weekend === weekend && e.n >= monitored.size * 0.9) perHour[e.hour].push(e.sum);
  console.log(`\nSoma dos setores por intervalo, mediana por hora (${weekend ? 'fim de semana' : 'dias úteis'}):`);
  console.log(perHour.map((v, h) => `${String(h).padStart(2, '0')}h:${v.length ? median(v).toFixed(0) : '-'}`).join('  '));
}

// variabilidade por setor (coef. de variação robusto por faixa horária ampla)
console.log('\nSetor | n | mediana | sigma/mediana | p97/mediana | zeros% (dias úteis, todas as horas)');
for (const s of unit.sectors.filter(x => x.monitored)) {
  const vals = loaded.readings
    .filter(r => r.sectorCode === s.code && isBaselineEligible(r))
    .map(r => r.intervalKwh as number);
  const sm = summarize(vals);
  const zeros = vals.filter(v => v === 0).length / Math.max(1, vals.length);
  console.log(
    `${s.name.padEnd(26)} n=${String(sm.n).padStart(5)}  med=${sm.median.toFixed(2).padStart(8)}  σ/med=${(sm.median ? sm.sigma / sm.median : 0).toFixed(2).padStart(5)}  p97/med=${(sm.median ? sm.p97 / sm.median : 0).toFixed(2).padStart(5)}  max=${sm.max.toFixed(1).padStart(8)}  zeros=${(zeros * 100).toFixed(0)}%`
  );
}
