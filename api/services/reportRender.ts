// Renderização do relatório em Excel (.xlsx) e PDF a partir do ReportModel.
// Não há lógica de negócio aqui: só apresentação. Toda decisão sobre quais
// linhas pertencem a qual unidade já foi validada em core/report/model.ts.

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { UNITS } from '../../core/units.js';
import { localParts } from '../../core/time.js';
import type { ReportModel, ReportRow, ReportSection } from '../../core/report/model.js';

const NOTE = 'Valores de excedente e custo são estimativas (consumo acima do esperado × tarifa da unidade), não faturamento.';

const pad = (n: number) => String(n).padStart(2, '0');
const fmtDateTime = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
};
const fmtDate = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
};
const num = (v: number, digits = 2) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const duration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${pad(min % 60)} min`);

/** Excel não guarda fuso: grava o relógio local como se fosse UTC para a célula mostrar a hora certa. */
function excelLocalDate(d: Date, tz: string): Date {
  const p = localParts(d, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

// ─── Excel ──────────────────────────────────────────────────────────────────────────────────────

const DETAIL_COLUMNS: { header: string; key: string; width: number; numFmt?: string; align?: 'left' | 'right' | 'center' }[] = [
  { header: 'Unidade', key: 'unit', width: 9, align: 'center' },
  { header: 'Setor', key: 'sector', width: 26 },
  { header: 'Início', key: 'openedAt', width: 17, numFmt: 'dd/mm/yyyy hh:mm' },
  { header: 'Fim', key: 'recoveredAt', width: 17, numFmt: 'dd/mm/yyyy hh:mm' },
  { header: 'Duração (min)', key: 'duration', width: 13, numFmt: '#,##0' },
  { header: 'Tipo de alerta', key: 'type', width: 34 },
  { header: 'Severidade (pico)', key: 'severity', width: 17 },
  { header: 'Faixa operacional', key: 'window', width: 22 },
  { header: 'Pico no intervalo (kWh)', key: 'peak', width: 17, numFmt: '#,##0.00' },
  { header: 'Esperado (kWh)', key: 'expected', width: 15, numFmt: '#,##0.00' },
  { header: 'Excedente (kWh)', key: 'excess', width: 15, numFmt: '#,##0.00' },
  { header: 'Custo estimado (R$)', key: 'cost', width: 18, numFmt: '"R$" #,##0.00' },
  { header: 'Tarifa (R$/kWh)', key: 'tariff', width: 14, numFmt: '0.0000' },
  { header: 'Status', key: 'status', width: 13 },
  { header: 'Notificações', key: 'notifications', width: 13, numFmt: '0' },
];

function addUnitSheets(wb: ExcelJS.Workbook, model: ReportModel, section: ReportSection) {
  const unit = UNITS[section.unit];
  const accent = argb(unit.accent);
  const tz = model.timezone;

  // --- detalhe ---
  const ws = wb.addWorksheet(`${section.unit} - Alertas`, { views: [{ state: 'frozen', ySplit: 3 }], properties: { tabColor: { argb: accent } } });
  ws.mergeCells(1, 1, 1, DETAIL_COLUMNS.length);
  const banner = ws.getCell(1, 1);
  banner.value = `UNIDADE ${section.unit} · Alertas de ${fmtDate(model.period.from, tz)} a ${fmtDate(model.period.to, tz)}`;
  banner.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
  banner.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  const header = ws.getRow(3);
  DETAIL_COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FF111827' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    cell.border = { bottom: { style: 'medium', color: { argb: accent } } };
    cell.alignment = { vertical: 'middle', horizontal: c.align ?? 'left', wrapText: true };
    ws.getColumn(i + 1).width = c.width;
  });
  header.height = 32;

  const first = 4;
  section.rows.forEach((r: ReportRow, idx) => {
    const row = ws.getRow(first + idx);
    const values: Record<string, unknown> = {
      unit: r.unit,
      sector: r.sectorName,
      openedAt: excelLocalDate(r.openedAt, tz),
      recoveredAt: r.recoveredAt ? excelLocalDate(r.recoveredAt, tz) : null,
      duration: r.durationMinutes,
      type: r.alertType,
      severity: r.severityLabel,
      window: r.windowName,
      peak: r.peakValueKwh,
      expected: r.baselineKwh,
      excess: r.totalExcessKwh,
      cost: r.totalCostBrl,
      tariff: r.tariffBrlPerKwh,
      status: r.status === 'open' ? 'Em aberto' : 'Recuperado',
      notifications: r.notificationCount,
    };
    DETAIL_COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = values[c.key] as ExcelJS.CellValue;
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.align) cell.alignment = { horizontal: c.align };
    });
  });

  const last = first + section.rows.length - 1;
  const totalRow = ws.getRow(last + 2);
  const colOf = (key: string) => DETAIL_COLUMNS.findIndex(c => c.key === key) + 1;
  totalRow.getCell(1).value = section.unit;
  totalRow.getCell(2).value = `TOTAL DO PERÍODO — ${section.unit}`;
  const sum = (key: string, result: number) => {
    const col = ws.getColumn(colOf(key)).letter;
    return { formula: section.rows.length ? `SUBTOTAL(109,${col}${first}:${col}${last})` : '0', result };
  };
  totalRow.getCell(colOf('duration')).value = sum('duration', section.rows.reduce((t, r) => t + r.durationMinutes, 0));
  totalRow.getCell(colOf('excess')).value = sum('excess', section.totals.excessKwh);
  totalRow.getCell(colOf('cost')).value = sum('cost', section.totals.costBrl);
  totalRow.getCell(colOf('notifications')).value = sum('notifications', section.totals.notifications);
  totalRow.getCell(colOf('type')).value = `${section.totals.alerts} alerta(s)`;
  totalRow.eachCell({ includeEmpty: false }, cell => {
    cell.font = { bold: true };
    cell.border = { top: { style: 'medium', color: { argb: accent } } };
  });
  for (const key of ['duration', 'excess', 'cost', 'notifications']) {
    const c = DETAIL_COLUMNS[colOf(key) - 1];
    if (c.numFmt) totalRow.getCell(colOf(key)).numFmt = c.numFmt;
  }
  if (section.rows.length > 0) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: last, column: DETAIL_COLUMNS.length } };
  ws.getCell(last + 4, 1).value = NOTE;
  ws.getCell(last + 4, 1).font = { italic: true, color: { argb: 'FF6B7280' } };

  // --- por setor ---
  const bs = wb.addWorksheet(`${section.unit} - Por setor`, { views: [{ state: 'frozen', ySplit: 3 }], properties: { tabColor: { argb: accent } } });
  bs.mergeCells(1, 1, 1, 5);
  const b2 = bs.getCell(1, 1);
  b2.value = `UNIDADE ${section.unit} · Totais por setor`;
  b2.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  b2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
  bs.getRow(1).height = 24;
  const heads = ['Unidade', 'Setor', 'Alertas', 'Excedente (kWh)', 'Custo estimado (R$)'];
  const widths = [9, 30, 10, 17, 20];
  heads.forEach((h, i) => {
    const cell = bs.getRow(3).getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    bs.getColumn(i + 1).width = widths[i];
  });
  section.bySector.forEach((s, idx) => {
    const row = bs.getRow(4 + idx);
    row.getCell(1).value = section.unit;
    row.getCell(2).value = s.sectorName;
    row.getCell(3).value = s.alerts;
    row.getCell(4).value = s.excessKwh;
    row.getCell(4).numFmt = '#,##0.00';
    row.getCell(5).value = s.costBrl;
    row.getCell(5).numFmt = '"R$" #,##0.00';
  });
  const bsTotal = bs.getRow(4 + section.bySector.length + 1);
  bsTotal.getCell(1).value = section.unit;
  bsTotal.getCell(2).value = `TOTAL DO PERÍODO — ${section.unit}`;
  bsTotal.getCell(3).value = section.totals.alerts;
  bsTotal.getCell(4).value = section.totals.excessKwh;
  bsTotal.getCell(4).numFmt = '#,##0.00';
  bsTotal.getCell(5).value = section.totals.costBrl;
  bsTotal.getCell(5).numFmt = '"R$" #,##0.00';
  bsTotal.eachCell(cell => {
    cell.font = { bold: true };
    cell.border = { top: { style: 'medium', color: { argb: accent } } };
  });
}

export async function renderXlsx(model: ReportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Alertas de Energia';
  wb.created = model.generatedAt;
  const tz = model.timezone;

  const sum = wb.addWorksheet('Resumo', { views: [{ showGridLines: false }] });
  sum.getColumn(1).width = 34;
  [2, 3, 4, 5].forEach(c => (sum.getColumn(c).width = 20));
  sum.getCell('A1').value = model.title;
  sum.getCell('A1').font = { bold: true, size: 15 };
  sum.getCell('A2').value = `Período: ${fmtDate(model.period.from, tz)} a ${fmtDate(model.period.to, tz)}`;
  sum.getCell('A3').value = `Gerado em: ${fmtDateTime(model.generatedAt, tz)} (horário de Brasília)`;
  const heads = ['Unidade', 'Alertas', 'Excedente (kWh)', 'Custo estimado (R$)', 'Notificações'];
  heads.forEach((h, i) => {
    const cell = sum.getRow(5).getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });
  model.sections.forEach((s, i) => {
    const row = sum.getRow(6 + i);
    row.getCell(1).value = `${s.unit}`;
    row.getCell(1).font = { bold: true, color: { argb: argb(UNITS[s.unit].accent) } };
    row.getCell(2).value = s.totals.alerts;
    row.getCell(3).value = s.totals.excessKwh;
    row.getCell(3).numFmt = '#,##0.00';
    row.getCell(4).value = s.totals.costBrl;
    row.getCell(4).numFmt = '"R$" #,##0.00';
    row.getCell(5).value = s.totals.notifications;
  });
  if (model.sections.length > 1) {
    const row = sum.getRow(6 + model.sections.length + 1);
    row.getCell(1).value = `Soma ${model.sections.map(s => s.unit).join(' + ')} (informativa)`;
    row.getCell(2).value = model.sections.reduce((t, s) => t + s.totals.alerts, 0);
    row.getCell(3).value = model.sections.reduce((t, s) => t + s.totals.excessKwh, 0);
    row.getCell(3).numFmt = '#,##0.00';
    row.getCell(4).value = model.sections.reduce((t, s) => t + s.totals.costBrl, 0);
    row.getCell(4).numFmt = '"R$" #,##0.00';
    row.getCell(5).value = model.sections.reduce((t, s) => t + s.totals.notifications, 0);
    row.eachCell(cell => (cell.font = { bold: true, italic: true }));
  }
  const noteRow = 6 + model.sections.length + 3;
  sum.getCell(`A${noteRow}`).value = NOTE;
  sum.getCell(`A${noteRow}`).font = { italic: true, color: { argb: 'FF6B7280' } };
  sum.getCell(`A${noteRow + 1}`).value = 'Cada unidade tem aba própria de detalhe e de totais por setor; registros de unidades diferentes nunca compartilham aba.';
  sum.getCell(`A${noteRow + 1}`).font = { italic: true, color: { argb: 'FF6B7280' } };

  for (const section of model.sections) addUnitSheets(wb, model, section);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── PDF ────────────────────────────────────────────────────────────────────────────────────────

interface PdfColumn {
  header: string;
  width: number;
  align: 'left' | 'right' | 'center';
  value: (r: ReportRow, tz: string) => string;
}

const PDF_COLUMNS: PdfColumn[] = [
  { header: 'Início', width: 82, align: 'left', value: (r, tz) => fmtDateTime(r.openedAt, tz) },
  { header: 'Setor', width: 118, align: 'left', value: r => r.sectorName },
  { header: 'Severidade', width: 62, align: 'left', value: r => r.severityLabel },
  { header: 'Faixa', width: 96, align: 'left', value: r => r.windowName },
  { header: 'Duração', width: 58, align: 'right', value: r => duration(r.durationMinutes) },
  { header: 'Pico kWh', width: 56, align: 'right', value: r => num(r.peakValueKwh) },
  { header: 'Esperado', width: 56, align: 'right', value: r => num(r.baselineKwh) },
  { header: 'Excedente kWh', width: 72, align: 'right', value: r => num(r.totalExcessKwh) },
  { header: 'Custo (R$)', width: 70, align: 'right', value: r => brl(r.totalCostBrl) },
  { header: 'Status', width: 56, align: 'left', value: r => (r.status === 'open' ? 'Em aberto' : 'Recuperado') },
];

export interface PdfOptions {
  /** desligar a compressão permite inspecionar o texto em testes */
  compress?: boolean;
}

export function renderPdf(model: ReportModel, options: PdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, compress: options.compress ?? true, info: { Title: model.title, Author: 'Alertas de Energia' } });
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tz = model.timezone;
    const left = doc.page.margins.left;
    const pageW = doc.page.width - left - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 18;
    const pageUnit: (string | null)[] = []; // unidade de cada página (rodapé)

    const banner = (unitCode: string | null, accent: string, subtitle: string) => {
      doc.save().rect(0, 0, doc.page.width, 46).fill(accent).restore();
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text(unitCode ? `UNIDADE ${unitCode}` : 'Resumo', left, 14, { width: 260, lineBreak: false });
      doc.font('Helvetica').fontSize(10).text(subtitle, left + 240, 18, { width: pageW - 240, align: 'right', lineBreak: false });
      doc.fillColor('#111827');
      pageUnit[doc.bufferedPageRange().count - 1] = unitCode;
    };

    // --- página de resumo ---
    banner(null, '#111827', `${fmtDate(model.period.from, tz)} a ${fmtDate(model.period.to, tz)}`);
    doc.y = 66;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(model.title, left, 66, { width: pageW });
    doc.font('Helvetica').fontSize(10).fillColor('#4B5563').moveDown(0.3)
      .text(`Período: ${fmtDate(model.period.from, tz)} a ${fmtDate(model.period.to, tz)}   ·   Gerado em ${fmtDateTime(model.generatedAt, tz)} (horário de Brasília)`);
    let y = doc.y + 18;
    for (const s of model.sections) {
      const accent = UNITS[s.unit].accent;
      doc.save().roundedRect(left, y, pageW, 64, 4).lineWidth(1).stroke('#D1D5DB').restore();
      doc.save().rect(left, y, 6, 64).fill(accent).restore();
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(20).text(s.unit, left + 18, y + 10, { width: 80, lineBreak: false });
      const kpis: [string, string][] = [
        ['Alertas', String(s.totals.alerts)],
        ['Excedente', `${num(s.totals.excessKwh)} kWh`],
        ['Custo estimado', brl(s.totals.costBrl)],
        ['Notificações', String(s.totals.notifications)],
      ];
      kpis.forEach(([label, value], i) => {
        const x = left + 130 + i * ((pageW - 140) / 4);
        doc.fillColor('#6B7280').font('Helvetica').fontSize(8).text(label.toUpperCase(), x, y + 12, { width: 150, lineBreak: false });
        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(13).text(value, x, y + 28, { width: 150, lineBreak: false });
      });
      y += 78;
    }
    doc.fillColor('#6B7280').font('Helvetica-Oblique').fontSize(8.5)
      .text(NOTE, left, y + 4, { width: pageW })
      .text('Cada unidade é apresentada em seção própria (páginas seguintes); registros de unidades diferentes nunca são misturados.', left, doc.y + 2, { width: pageW });

    // --- uma seção por unidade ---
    for (const s of model.sections) {
      const accent = UNITS[s.unit].accent;
      const startPage = () => {
        doc.addPage();
        banner(s.unit, accent, `Alertas de ${fmtDate(model.period.from, tz)} a ${fmtDate(model.period.to, tz)}`);
        doc.y = 62;
      };
      startPage();

      // por setor
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12).text(`Totais por setor — ${s.unit}`, left, doc.y);
      doc.moveDown(0.4);
      const sectorCols = [{ h: 'Setor', w: 260, a: 'left' as const }, { h: 'Alertas', w: 70, a: 'right' as const }, { h: 'Excedente (kWh)', w: 120, a: 'right' as const }, { h: 'Custo estimado', w: 120, a: 'right' as const }];
      const drawHead = (cols: { h: string; w: number; a: 'left' | 'right' | 'center' }[]) => {
        const top = doc.y;
        doc.save().rect(left, top, cols.reduce((t, c) => t + c.w, 0), 16).fill('#F3F4F6').restore();
        let x = left;
        cols.forEach(c => {
          doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8).text(c.h, x + 3, top + 4, { width: c.w - 6, align: c.a, lineBreak: false });
          x += c.w;
        });
        doc.y = top + 18;
      };
      drawHead(sectorCols);
      doc.font('Helvetica').fontSize(8.5).fillColor('#111827');
      for (const row of s.bySector.slice(0, 12)) {
        if (doc.y > bottomLimit()) { startPage(); drawHead(sectorCols); doc.font('Helvetica').fontSize(8.5); }
        const top = doc.y;
        const cells = [row.sectorName, String(row.alerts), num(row.excessKwh), brl(row.costBrl)];
        let x = left;
        sectorCols.forEach((c, i) => {
          doc.fillColor('#111827').text(cells[i], x + 3, top + 2, { width: c.w - 6, align: c.a, lineBreak: false, ellipsis: true });
          x += c.w;
        });
        doc.y = top + 15;
      }
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(accent).text(
        `TOTAL DO PERÍODO — ${s.unit}:  ${s.totals.alerts} alerta(s)  ·  ${num(s.totals.excessKwh)} kWh excedentes  ·  ${brl(s.totals.costBrl)}`, left, doc.y, { width: pageW });
      doc.moveDown(1);

      // detalhe
      if (doc.y > bottomLimit() - 60) startPage();
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12).text(`Detalhamento dos alertas — ${s.unit}`, left, doc.y);
      doc.moveDown(0.4);
      const cols = PDF_COLUMNS.map(c => ({ h: c.header, w: c.width, a: c.align }));
      drawHead(cols);
      if (s.rows.length === 0) {
        doc.fillColor('#6B7280').font('Helvetica-Oblique').fontSize(9).text('Nenhum alerta no período.', left + 3, doc.y + 2);
      }
      s.rows.forEach((r, i) => {
        if (doc.y > bottomLimit()) { startPage(); drawHead(cols); }
        const top = doc.y;
        if (i % 2 === 1) doc.save().rect(left, top, cols.reduce((t, c) => t + c.w, 0), 15).fill('#F9FAFB').restore();
        let x = left;
        PDF_COLUMNS.forEach(c => {
          doc.fillColor('#111827').font('Helvetica').fontSize(8).text(c.value(r, tz), x + 3, top + 3, { width: c.width - 6, align: c.align, lineBreak: false, ellipsis: true });
          x += c.width;
        });
        doc.y = top + 15;
      });
      if (s.rows.length > 0) {
        if (doc.y > bottomLimit()) { startPage(); }
        const top = doc.y + 2;
        doc.save().moveTo(left, top).lineTo(left + pageW, top).lineWidth(1).stroke(accent).restore();
        doc.fillColor(accent).font('Helvetica-Bold').fontSize(9)
          .text(`TOTAL DO PERÍODO — ${s.unit}:  ${s.totals.alerts} alerta(s)   ·   Excedente ${num(s.totals.excessKwh)} kWh   ·   Custo estimado ${brl(s.totals.costBrl)}`, left, top + 6, { width: pageW });
      }
    }

    // --- rodapés (numeração de páginas, com a unidade da página) ---
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const footerY = doc.page.height - doc.page.margins.bottom + 6;
      doc.page.margins.bottom = 0; // escrever abaixo da margem sem o pdfkit criar página nova
      doc.fillColor('#6B7280').font('Helvetica').fontSize(8).text(
        `${pageUnit[i] ? `Unidade ${pageUnit[i]}` : 'Resumo'}  ·  ${model.title}  ·  Página ${i + 1} de ${range.count}`,
        left, footerY, { width: pageW, align: 'center', lineBreak: false }
      );
    }
    doc.end();
  });
}
