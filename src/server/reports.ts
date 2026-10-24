import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { buildMonth, salaryView, type MonthView, type SalaryView } from './calc.ts';
import type { DayType, UserRow } from './db.ts';
import { euro, fmtDuration, monthLabel, weekdayLabel } from './time.ts';

export interface MonthReport {
  user: { id: number; name: string };
  ym: string;
  label: string;
  month: MonthView;
  salary: SalaryView;
}

export function monthReport(user: UserRow, ym: string): MonthReport {
  const month = buildMonth(user, ym);
  return {
    user: { id: user.id, name: user.display_name },
    ym,
    label: monthLabel(ym),
    month,
    salary: salaryView(user.id, ym, month.totals.minutes),
  };
}

const TYPE_LABEL: Record<DayType, string> = {
  ferie: 'Ferie',
  malattia: 'Malattia',
  permesso: 'Permesso',
  festivo: 'Festivo',
  riposo: 'Riposo',
};

function dayStatus(d: MonthReport['month']['days'][number]): string {
  if (d.type) return TYPE_LABEL[d.type];
  if (d.entries.length) return 'Lavoro';
  if (d.autoRest) return 'Riposo';
  if (d.todo) return 'Da compilare';
  return '';
}

function shifts(d: MonthReport['month']['days'][number]): string {
  return d.entries.map((e) => `${e.start}–${e.end ? e.end + (e.nextDay ? ' (+1)' : '') : 'in corso'}`).join('   ');
}

function rate(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(2).replace('.', ',')} €/h`;
}

function summaryRows(r: MonthReport): [string, string][] {
  const t = r.month.totals;
  const rows: [string, string][] = [
    ['Ore totali', fmtDuration(t.minutes)],
    ['Ore (decimali)', (t.minutes / 60).toFixed(2).replace('.', ',')],
    ['Giorni lavorati', String(t.workedDays)],
    ['Media per giorno lavorato', fmtDuration(t.avgMinutesPerWorkedDay)],
    ['Giorni di ferie', String(t.byType.ferie)],
    ['Giorni di malattia', String(t.byType.malattia)],
    ['Giorni di permesso', String(t.byType.permesso)],
    ['Giorni festivi', String(t.byType.festivo)],
    ['Giorni di riposo', String(t.byType.riposo)],
    ['Giorni da compilare', String(t.todoDays)],
    ['Stipendio netto', euro(r.salary.netCents)],
    ['Paga oraria netta', rate(r.salary.rates.net)],
  ];
  if (r.salary.grossCents != null) {
    rows.push(['Stipendio lordo', euro(r.salary.grossCents)], ['Paga oraria lorda', rate(r.salary.rates.gross)]);
  }
  return rows;
}

export function renderPdf(r: MonthReport, detail: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Ore lavorate ${r.label}`, Author: 'Ore Lavoro' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const width = doc.page.width - 80;

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111').text(`Ore lavorate – ${r.label}`);
    doc.fontSize(11).font('Helvetica').fillColor('#555').text(`${r.user.name} · Report ${detail ? 'dettagliato' : 'sintetico'}`);
    doc.moveDown(1);

    // sintesi
    let y = doc.y;
    for (const [k, v] of summaryRows(r)) {
      doc.font('Helvetica').fontSize(11).fillColor('#333').text(k, left, y, { width: width * 0.6 });
      doc.font('Helvetica-Bold').fillColor('#111').text(v, left + width * 0.6, y, { width: width * 0.4, align: 'right' });
      y += 19;
      doc
        .strokeColor('#e3e6ea')
        .lineWidth(0.5)
        .moveTo(left, y - 3)
        .lineTo(left + width, y - 3)
        .stroke();
    }
    doc.y = y;

    if (detail) {
      doc.addPage();
      const cols = [
        { x: left, w: 80, label: 'Giorno' },
        { x: left + 80, w: 70, label: 'Tipo' },
        { x: left + 150, w: 270, label: 'Turni' },
        { x: left + 420, w: 75, label: 'Totale', right: true },
      ];
      const header = (yy: number) => {
        doc.rect(left, yy - 3, width, 20).fill('#eef1f5');
        doc.fillColor('#111').font('Helvetica-Bold').fontSize(10);
        for (const c of cols) doc.text(c.label, c.x + 4, yy + 2, { width: c.w - 8, align: c.right ? 'right' : 'left' });
        return yy + 22;
      };
      let yy = header(doc.page.margins.top);
      for (const d of r.month.days) {
        if (yy > doc.page.height - 70) {
          doc.addPage();
          yy = header(doc.page.margins.top);
        }
        const [, m, dd] = d.date.split('-');
        const weekend = d.weekday === 0 || d.weekday === 6;
        if (weekend) doc.rect(left, yy - 3, width, 18).fill('#f7f8fa');
        doc.fillColor(d.todo ? '#b42318' : '#222').font('Helvetica').fontSize(10);
        doc.text(`${dd}/${m} ${weekdayLabel(d.date, true)}`, cols[0].x + 4, yy, { width: cols[0].w - 8 });
        doc.text(dayStatus(d), cols[1].x + 4, yy, { width: cols[1].w - 8 });
        doc.text(shifts(d), cols[2].x + 4, yy, { width: cols[2].w - 8 });
        doc.font('Helvetica-Bold').text(d.minutes ? fmtDuration(d.minutes) : '', cols[3].x + 4, yy, { width: cols[3].w - 8, align: 'right' });
        yy += 18;
      }
      doc.rect(left, yy - 3, width, 20).fill('#eef1f5');
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(10);
      doc.text('Totale mese', left + 4, yy + 2, { width: 300 });
      doc.text(fmtDuration(r.month.totals.minutes), cols[3].x + 4, yy + 2, { width: cols[3].w - 8, align: 'right' });
    }

    doc.end();
  });
}

export async function renderXlsx(r: MonthReport, detail: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ore Lavoro';
  const s = wb.addWorksheet('Sintesi');
  s.columns = [{ width: 30 }, { width: 22 }];
  s.addRow([`Ore lavorate – ${r.label}`]).font = { bold: true, size: 14 };
  s.addRow([r.user.name]);
  s.addRow([]);
  for (const [k, v] of summaryRows(r)) {
    const row = s.addRow([k, v]);
    row.getCell(2).alignment = { horizontal: 'right' };
  }

  if (detail) {
    const w = wb.addWorksheet('Dettaglio');
    w.columns = [
      { header: 'Data', key: 'date', width: 12 },
      { header: 'Giorno', key: 'wd', width: 12 },
      { header: 'Tipo', key: 'type', width: 14 },
      { header: 'Turni', key: 'shifts', width: 40 },
      { header: 'Minuti', key: 'min', width: 10 },
      { header: 'Ore', key: 'hours', width: 10 },
    ];
    w.getRow(1).font = { bold: true };
    w.views = [{ state: 'frozen', ySplit: 1 }];
    for (const d of r.month.days) {
      const [y, m, dd] = d.date.split('-').map(Number);
      const row = w.addRow({
        date: new Date(Date.UTC(y, m - 1, dd)),
        wd: weekdayLabel(d.date),
        type: dayStatus(d),
        shifts: shifts(d),
        min: d.minutes || null,
        hours: d.minutes ? Math.round((d.minutes / 60) * 100) / 100 : null,
      });
      row.getCell('date').numFmt = 'dd/mm/yyyy';
      row.getCell('hours').numFmt = '0.00';
    }
    const n = r.month.days.length;
    const tot = w.addRow({ date: 'Totale', min: { formula: `SUM(E2:E${n + 1})`, result: r.month.totals.minutes }, hours: { formula: `SUM(F2:F${n + 1})`, result: r.month.totals.minutes / 60 } });
    tot.font = { bold: true };
    tot.getCell('hours').numFmt = '0.00';
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function reportFilename(r: MonthReport, detail: boolean, ext: 'pdf' | 'xlsx'): string {
  const who = r.user.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'utente';
  return `ore_${r.ym}_${who}_${detail ? 'dettaglio' : 'sintesi'}.${ext}`;
}
