import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildReportModel, reportFileName, ReportIntegrityError, type ReportAlert } from '../core/report/model.js';
import { renderPdf, renderXlsx } from '../backend/services/reportRender.js';
import { UNITS, type UnitCode } from '../core/units.js';
import { pdfText } from './helpers.js';

const TZ = 'America/Sao_Paulo';

function alert(id: number, unit: UnitCode, sectorIndex: number, over: Partial<ReportAlert> = {}): ReportAlert {
  const s = UNITS[unit].sectors[sectorIndex];
  return {
    id, unit, sectorCode: s.code, sectorName: s.name,
    openedAt: new Date(Date.UTC(2026, 8, 20 + (id % 5), 15, 0)), recoveredAt: new Date(Date.UTC(2026, 8, 20 + (id % 5), 17, 30)),
    durationMinutes: 150, windowName: 'Tarde', peakSeverity: 'alto', peakValueKwh: 30 + id, baselineKwh: 20, totalExcessKwh: 12.5 + id,
    totalCostBrl: Math.round((12.5 + id) * 0.75 * 100) / 100, tariffBrlPerKwh: 0.75, status: 'recovered', notificationCount: 1, origin: 'engine',
    ...over,
  };
}

const period = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T23:59:59Z') };
const generatedAt = new Date('2026-10-07T15:00:00Z');

describe('integridade do relatório (HCN nunca vira HMB)', () => {
  test('monta duas seções independentes, cada uma com seus totais', () => {
    const hcn = [alert(1, 'HCN', 4), alert(2, 'HCN', 5)];
    const hmb = [alert(3, 'HMB', 0), alert(4, 'HMB', 1), alert(5, 'HMB', 2)];
    const model = buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HCN: hcn, HMB: hmb } });
    assert.deepEqual(model.sections.map(s => s.unit), ['HCN', 'HMB']);
    assert.equal(model.sections[0].totals.alerts, 2);
    assert.equal(model.sections[1].totals.alerts, 3);
    assert.ok(model.sections[0].rows.every(r => r.unit === 'HCN'));
    assert.ok(model.sections[1].rows.every(r => r.unit === 'HMB'));
    assert.equal(model.sections[0].totals.costBrl, Math.round(hcn.reduce((t, a) => t + a.totalCostBrl, 0) * 100) / 100);
  });

  test('recusa registro de uma unidade na seção de outra', () => {
    assert.throws(
      () => buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HMB: [alert(1, 'HCN', 0)] } }),
      (e: unknown) => e instanceof ReportIntegrityError && /HCN.*seção HMB/.test((e as Error).message)
    );
  });

  test('recusa setor que não pertence à unidade, mesmo com o rótulo da unidade certo', () => {
    const wrong = { ...alert(1, 'HMB', 0), sectorCode: 'DJ50_CME', sectorName: 'CME' }; // código do HCN marcado como HMB
    assert.throws(() => buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HMB: [wrong] } }), /não pertence à unidade HMB/);
  });

  test('o nome do arquivo identifica unidade(s) e período', () => {
    const one = buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HMB: [] } });
    assert.equal(reportFileName(one, 'xlsx'), 'alertas_HMB_2026-09-01_a_2026-09-30.xlsx');
    const both = buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HCN: [], HMB: [] } });
    assert.equal(reportFileName(both, 'pdf'), 'alertas_HCN-HMB_2026-09-01_a_2026-09-30.pdf');
  });

  test('relatório sem unidade é inválido', () => {
    assert.throws(() => buildReportModel({ generatedAt, timezone: TZ, period, byUnit: {} }), ReportIntegrityError);
  });
});

describe('Excel', () => {
  const hcn = [alert(1, 'HCN', 4), alert(2, 'HCN', 5, { recoveredAt: null, status: 'open', peakSeverity: 'critico' })];
  const hmb = [alert(3, 'HMB', 0), alert(4, 'HMB', 1), alert(5, 'HMB', 6, { peakSeverity: null, origin: 'legacy_import' })];
  const model = buildReportModel({ generatedAt, timezone: TZ, period, byUnit: { HCN: hcn, HMB: hmb } });

  async function open() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await renderXlsx(model));
    return wb;
  }

  test('abas separadas por unidade e uma aba de resumo', async () => {
    const wb = await open();
    assert.deepEqual(wb.worksheets.map(w => w.name), ['Resumo', 'HCN - Alertas', 'HCN - Por setor', 'HMB - Alertas', 'HMB - Por setor']);
  });

  test('toda linha de uma aba pertence à unidade da aba e o setor pertence ao registro da unidade', async () => {
    const wb = await open();
    for (const unit of ['HCN', 'HMB'] as const) {
      const ws = wb.getWorksheet(`${unit} - Alertas`)!;
      const sectorNames = new Set(UNITS[unit].sectors.map(s => s.name));
      let dataRows = 0;
      let reachedTotal = false;
      ws.eachRow((row, n) => {
        if (n < 4 || reachedTotal) return;
        if (String(row.getCell(2).value).startsWith('TOTAL')) {
          reachedTotal = true;
          return;
        }
        const first = String(row.getCell(1).value ?? '');
        dataRows++;
        assert.equal(first, unit, `linha ${n} da aba ${unit}`);
        assert.ok(sectorNames.has(String(row.getCell(2).value)), `setor "${row.getCell(2).value}" pertence ao ${unit}`);
      });
      assert.equal(dataRows, model.sections.find(s => s.unit === unit)!.rows.length);
    }
  });

  test('total do período por unidade bate com a soma das linhas e o resumo traz os dois lado a lado', async () => {
    const wb = await open();
    const ws = wb.getWorksheet('HMB - Alertas')!;
    let total: ExcelJS.Row | undefined;
    ws.eachRow(r => {
      if (String(r.getCell(2).value).startsWith('TOTAL DO PERÍODO — HMB')) total = r;
    });
    assert.ok(total);
    const section = model.sections[1];
    const cost = total!.getCell(12).value as { result: number };
    assert.equal(cost.result, section.totals.costBrl);
    const resumo = wb.getWorksheet('Resumo')!;
    assert.equal(resumo.getCell('A6').value, 'HCN');
    assert.equal(resumo.getCell('A7').value, 'HMB');
    assert.equal(resumo.getCell('D6').value, model.sections[0].totals.costBrl);
    assert.equal(resumo.getCell('D7').value, section.totals.costBrl);
  });

  test('datas gravadas no relógio local de Brasília e registros legados rotulados', async () => {
    const wb = await open();
    const ws = wb.getWorksheet('HCN - Alertas')!;
    const opened = ws.getCell('C4').value as Date;
    assert.equal(opened.getUTCHours(), 12); // 15:00Z = 12:00 em Brasília
    const hmb = wb.getWorksheet('HMB - Alertas')!;
    const types: string[] = [];
    hmb.eachRow((r, n) => {
      if (n >= 4) types.push(String(r.getCell(6).value));
    });
    assert.ok(types.some(t => t.includes('histórico V1')));
  });
});

describe('PDF', () => {
  const model = buildReportModel({
    generatedAt, timezone: TZ, period,
    byUnit: { HCN: Array.from({ length: 45 }, (_, i) => alert(i + 1, 'HCN', i % 10)), HMB: [alert(100, 'HMB', 0), alert(101, 'HMB', 3)] },
  });

  test('gera PDF válido, paginado, com a unidade identificada em cada seção e totais', async () => {
    const buf = await renderPdf(model, { compress: false });
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    assert.ok(pages >= 4, `páginas: ${pages}`); // resumo + HCN (várias) + HMB
    const lines = pdfText(buf);
    const text = lines.join('\n');
    for (const needle of ['UNIDADE HCN', 'UNIDADE HMB', 'TOTAL DO PERÍODO — HCN', 'TOTAL DO PERÍODO — HMB']) {
      assert.ok(text.includes(needle), `contém "${needle}"`);
    }
    // todo rodapé de página identifica a unidade: as páginas do HCN nunca carregam "Unidade HMB"
    const footers = lines.filter(l => l.includes('Página'));
    assert.equal(footers.length, pages);
    assert.ok(footers.filter(l => l.startsWith('Unidade HCN')).length >= 2);
    assert.equal(footers.filter(l => l.startsWith('Unidade HMB')).length, 1);
    assert.equal(footers.filter(l => l.startsWith('Resumo')).length, 1);
    // nenhum setor exclusivo do HMB aparece nas páginas do HCN e vice-versa
    const hcnStart = lines.findIndex(l => l === 'UNIDADE HCN');
    const hmbStart = lines.findIndex(l => l === 'UNIDADE HMB');
    assert.ok(hcnStart >= 0 && hmbStart > hcnStart);
    const hcnPart = lines.slice(hcnStart, hmbStart);
    const hmbPart = lines.slice(hmbStart);
    const hmbOnly = ['Lactário', 'Vácuo', 'Cozinha'];
    assert.ok(!hcnPart.some(l => hmbOnly.includes(l)));
    assert.ok(!hmbPart.some(l => ['Ressonância', 'Radiologia', 'Oncologia'].includes(l)));
  });

  test('versão comprimida (produção) também é válida', async () => {
    const buf = await renderPdf(model);
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 2000);
  });
});
