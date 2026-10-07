// Tabela de sensibilidade: para cada setor, quanto acima do esperado o consumo
// precisa ir para virar ATENÇÃO / ALTO / CRÍTICO em cada faixa (dias úteis).
// Responde "o motor enxerga um problema de X%?" sem precisar esperar um incidente.
//
//   npx tsx scripts/sensitivity.ts HMB backups/2026-10-07-pre-v2/hmb_tel.csv [faixa=tarde]
import { loadUnitFromCsv } from './lib/load.js';
import { isBaselineEligible } from '../core/telemetry/normalize.js';
import { buildBaselineSet, pickBaseline, type BaselineContext } from '../core/alerts/baseline.js';
import { evaluateValue } from '../core/alerts/detector.js';
import { DEFAULT_RULES } from '../core/alerts/rules.js';
import { DEFAULT_WINDOWS } from '../core/alerts/windows.js';
import { isUnitCode } from '../core/units.js';

const [code, csv, windowKey = 'tarde'] = process.argv.slice(2);
if (!isUnitCode(code) || !csv) throw new Error('uso: sensitivity.ts <HCN|HMB> <csv> [faixa]');

const loaded = loadUnitFromCsv(code, csv);
const { unit } = loaded;
const rules = process.env.RULES_JSON ? { ...DEFAULT_RULES, ...JSON.parse(process.env.RULES_JSON) } : DEFAULT_RULES;
const ctx: BaselineContext = { windows: DEFAULT_WINDOWS, intervalMin: unit.expectedIntervalMin, timeZone: unit.timezone, rules };
const window = DEFAULT_WINDOWS.find(w => w.key === windowKey);
if (!window) throw new Error(`faixa desconhecida: ${windowKey}`);

console.log(`${code} — faixa "${window.name}" (dias úteis). Limite = quanto acima da mediana vira cada nível.\n`);
console.log('Setor'.padEnd(26) + 'n'.padStart(5) + 'mediana'.padStart(9) + 'σ efetivo'.padStart(11) + '   ATENÇÃO'.padStart(14) + '      ALTO'.padStart(12) + '   CRÍTICO'.padStart(12) + '   envelope');
for (const s of unit.sectors.filter(x => x.monitored)) {
  const samples = loaded.readings
    .filter(r => r.sectorCode === s.code && isBaselineEligible(r))
    .map(r => ({ ts: r.ts, kwh: r.intervalKwh as number }));
  const set = buildBaselineSet(samples, new Date(loaded.lastTs.getTime() + 1000), ctx);
  const b = pickBaseline(set, window.key, 'weekday', rules.minBaselineSamples);
  if (!b) {
    console.log(s.name.padEnd(26) + ' sem baseline');
    continue;
  }
  const ev = evaluateValue(b.median, b, window, 'weekday', rules, unit.expectedIntervalMin);
  const pct = (limit: number) => (b.median > 0 ? `+${(((limit - b.median) / b.median) * 100).toFixed(0)}%` : 'n/d');
  console.log(
    s.name.padEnd(26) +
      String(b.n).padStart(5) +
      b.median.toFixed(2).padStart(9) +
      ev.sigma.toFixed(2).padStart(11) +
      `${ev.limits.atencao.toFixed(1)} (${pct(ev.limits.atencao)})`.padStart(16) +
      `${ev.limits.alto.toFixed(1)} (${pct(ev.limits.alto)})`.padStart(14) +
      `${ev.limits.critico.toFixed(1)} (${pct(ev.limits.critico)})`.padStart(15) +
      `   ${ev.envelope.toFixed(1)}`
  );
}
