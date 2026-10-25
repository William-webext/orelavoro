// Genera il manuale in Word (.docx) partendo da docs/MANUALE.md, così le due versioni restano identiche.
//   cd docs/tools && npm install            (una volta)
//   node docs/tools/build-docx.mjs          → docs/Manuale-Ore-Lavoro.docx
// Il file contiene un indice da aggiornare: lo script build-docx.ps1 lo aggiorna con Word (se installato).
import fs from 'node:fs';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

const DOCS = path.resolve(import.meta.dirname, '..');
const SRC = path.join(DOCS, 'MANUALE.md');
const OUT = process.argv[2] ?? path.join(DOCS, 'Manuale-Ore-Lavoro.docx');

// ---------- stile ----------
const C = { primary: '0E7490', ink: '14202B', muted: '5B6878', line: 'D5DBE2', zebra: 'F6F8FA', codeBg: 'F3F5F7', head: '0E7490' };
const CALLOUT = {
  Nota: { fill: 'E3F2F7', bar: '0E7490', label: '0B5F77' },
  Suggerimento: { fill: 'E6F4EA', bar: '2E8B57', label: '1F6B3F' },
  Attenzione: { fill: 'FDF0D5', bar: 'D9822B', label: '9A5B00' },
};
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134; // 2 cm
const TEXT_W = PAGE_W - 2 * MARGIN; // 9638 DXA = 17 cm
const BODY = 21; // 10,5 pt
const IMG_SCALE = 0.92; // riduce un po' le schermate per sprecare meno spazio

// ---------- immagini ----------
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('JPEG non valido');
}
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function imageRun(file, widthPx, alt) {
  const data = fs.readFileSync(file);
  const isPng = file.toLowerCase().endsWith('.png');
  const { w, h } = isPng ? pngSize(data) : jpegSize(data);
  return new ImageRun({
    type: isPng ? 'png' : 'jpg',
    data,
    transformation: { width: widthPx, height: Math.round((widthPx * h) / w) },
    altText: { title: alt, description: alt, name: path.basename(file) },
  });
}

// ---------- testo con formattazione ----------
function inline(text, base = {}) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(new TextRun({ text: buf, ...base }));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const j = text.indexOf('**', i + 2);
      if (j > 0) {
        flush();
        out.push(...inline(text.slice(i + 2, j), { ...base, bold: true }));
        i = j + 2;
        continue;
      }
    }
    if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > 0) {
        flush();
        out.push(
          new TextRun({
            text: text.slice(i + 1, j),
            font: 'Courier New',
            size: Math.max(16, (base.size ?? BODY) - 2),
            color: base.color ?? C.ink,
            bold: base.bold,
            shading: { type: ShadingType.CLEAR, fill: 'EEF1F5', color: 'auto' },
          }),
        );
        i = j + 1;
        continue;
      }
    }
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ') {
      const j = text.indexOf('*', i + 1);
      if (j > i + 1 && text[j - 1] !== ' ') {
        flush();
        out.push(...inline(text.slice(i + 1, j), { ...base, italics: true }));
        i = j + 1;
        continue;
      }
    }
    if (text[i] === '[') {
      const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        out.push(new ExternalHyperlink({ link: m[2], children: [new TextRun({ text: m[1], ...base, color: C.primary, underline: {} })] }));
        i += m[0].length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}
const plain = (t) => t.replace(/\*\*|`|\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

// ---------- lettura del Markdown ----------
const md = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = md.split('\n');
const blocks = [];
const isListLine = (l) => /^\s*([-*]|\d+\.) /.test(l);
const isBlockStart = (l) => /^(#{1,4} |```|\||> |<!--|<p align)/.test(l) || isListLine(l);
let ordInstance = 0;

for (let i = 0; i < lines.length; ) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  if (line.startsWith('<!-- pagebreak')) { blocks.push({ t: 'pagebreak' }); i++; continue; }
  if (line.startsWith('<!-- toc')) { blocks.push({ t: 'toc' }); i++; continue; }
  if (line.startsWith('<p align')) {
    const html = [];
    while (i < lines.length && !lines[i].startsWith('</p>')) html.push(lines[i++]);
    i++;
    const imgs = [...html.join(' ').matchAll(/<img src="([^"]+)" width="(\d+)" alt="([^"]*)"/g)].map((m) => ({ src: m[1], width: Number(m[2]), alt: m[3] }));
    blocks.push({ t: 'images', imgs });
    continue;
  }
  let m = /^(#{1,4}) (.*)$/.exec(line);
  if (m) { blocks.push({ t: 'h', level: m[1].length, text: m[2] }); i++; continue; }
  if (line.startsWith('```')) {
    const code = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
    i++;
    blocks.push({ t: 'code', lines: code });
    continue;
  }
  if (line.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
    const cells = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    blocks.push({ t: 'table', header: cells(rows[0]), rows: rows.slice(2).map(cells) });
    continue;
  }
  if (line.startsWith('> ')) {
    const q = [];
    while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
    blocks.push({ t: 'quote', text: q.join(' ') });
    continue;
  }
  if (isListLine(line)) {
    const items = [];
    const ordered = /^\s*\d+\./.test(line);
    // una lista che riparte da 2, 3… (dopo un blocco di codice o una tabella) continua la precedente
    const startNum = ordered ? Number(/^\s*(\d+)\./.exec(line)[1]) : 0;
    const inst = ordered ? (startNum > 1 && ordInstance > 0 ? ordInstance : ++ordInstance) : 0;
    while (i < lines.length && lines[i].trim() && isListLine(lines[i])) {
      const mm = /^(\s*)([-*]|\d+\.) (.*)$/.exec(lines[i]);
      items.push({ level: Math.min(2, Math.floor(mm[1].length / 2)), text: mm[3] });
      i++;
      // righe di continuazione (indentate, non elenco)
      while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !isListLine(lines[i])) items[items.length - 1].text += ' ' + lines[i++].trim();
    }
    blocks.push({ t: 'list', ordered, inst, items });
    continue;
  }
  const para = [];
  while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
  blocks.push({ t: 'p', text: para.join(' ') });
}

// ---------- costruzione degli elementi ----------
const children = [];
const cover = [];
let inCover = true;
let figure = 0;
let pendingBreak = false; // il prossimo titolo comincia su una pagina nuova (senza pagine vuote)

function table(b) {
  const n = b.header.length;
  const weight = Array.from({ length: n }, (_, c) => {
    const all = [b.header[c], ...b.rows.map((r) => r[c] ?? '')];
    const longest = Math.max(...all.map((t) => plain(t).length));
    const avg = all.reduce((s, t) => s + plain(t).length, 0) / all.length;
    return Math.min(60, Math.max(8, (longest * 0.35 + avg * 0.65) * (n > 3 ? 1 : 1.15)));
  });
  const sum = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map((w) => Math.max(1000, Math.round((w / sum) * TEXT_W)));
  widths[widths.length - 1] += TEXT_W - widths.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: C.line };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text, c, head, zebra) =>
    new TableCell({
      width: { size: widths[c], type: WidthType.DXA },
      borders,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: head ? { type: ShadingType.CLEAR, fill: C.primary, color: 'auto' } : zebra ? { type: ShadingType.CLEAR, fill: C.zebra, color: 'auto' } : undefined,
      children: [new Paragraph({ spacing: { after: 0, line: 252 }, children: inline(text ?? '', head ? { bold: true, color: 'FFFFFF', size: 19 } : { size: 19 }) })],
    });
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: b.header.map((h, c) => cell(h, c, true, false)) }),
      ...b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: b.header.map((_, c) => cell(r[c], c, false, ri % 2 === 1)) })),
    ],
  });
}

function callout(text) {
  const m = /^\*\*(Nota|Suggerimento|Attenzione)([^*]*)\*\*\s*(.*)$/.exec(text);
  if (!m) {
    return new Paragraph({ spacing: { before: 80, after: 160 }, indent: { left: 300 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: C.line, space: 8 } }, children: inline(text, { italics: true, color: C.muted }) });
  }
  const st = CALLOUT[m[1]];
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA },
    columnWidths: [TEXT_W],
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: TEXT_W, type: WidthType.DXA },
            borders: { top: none, bottom: none, right: none, left: { style: BorderStyle.SINGLE, size: 24, color: st.bar } },
            shading: { type: ShadingType.CLEAR, fill: st.fill, color: 'auto' },
            margins: { top: 100, bottom: 100, left: 200, right: 160 },
            children: [
              new Paragraph({
                spacing: { after: 0, line: 264 },
                children: [new TextRun({ text: m[1] + m[2] + ' ', bold: true, color: st.label, size: 20 }), ...inline(m[3], { size: 20 })],
              }),
            ],
          }),
        ],
      }),
      // riga vuota sottile per staccare dal testo successivo
    ],
  });
}

function images(b) {
  figure++;
  const n = b.imgs.length;
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const nb = { top: none, bottom: none, left: none, right: none };
  const w = Math.floor(TEXT_W / n);
  const frame = { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 2 };
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA },
    columnWidths: Array(n).fill(w),
    alignment: AlignmentType.CENTER,
    rows: [
      new TableRow({
        cantSplit: true,
        children: b.imgs.map(
          (im) =>
            new TableCell({
              width: { size: w, type: WidthType.DXA },
              borders: nb,
              margins: { top: 40, bottom: 40, left: 40, right: 40 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  keepNext: true,
                  spacing: { after: 0, before: 0 },
                  border: { top: frame, bottom: frame, left: frame, right: frame },
                  children: [imageRun(path.join(DOCS, im.src), Math.round(im.width * IMG_SCALE), im.alt)],
                }),
              ],
            }),
        ),
      }),
    ],
  });
}

for (const b of blocks) {
  let target = inCover ? cover : children;
  switch (b.t) {
    case 'pagebreak':
      if (inCover) inCover = false;
      else pendingBreak = true;
      break;
    case 'toc':
      children.push(new Paragraph({ pageBreakBefore: pendingBreak, spacing: { after: 200 }, children: [new TextRun({ text: 'Indice', bold: true, size: 40, color: C.head })] }));
      pendingBreak = false;
      children.push(new TableOfContents('Indice', { hyperlink: true, headingStyleRange: '1-2' }));
      break;
    case 'h': {
      if (b.level === 1) { cover.push({ title: b.text }); break; }
      const level = [null, null, 'HEADING_1', 'HEADING_2', 'HEADING_3'][b.level];
      target.push(new Paragraph({ heading: { HEADING_1: 'Heading1', HEADING_2: 'Heading2', HEADING_3: 'Heading3' }[level], pageBreakBefore: !inCover && pendingBreak, children: [new TextRun({ text: b.text })] }));
      pendingBreak = false;
      break;
    }
    case 'p': {
      if (inCover) { cover.push({ text: b.text }); break; }
      const cap = /^\*(Figura \d+ — .*)\*$/.exec(b.text);
      if (cap) {
        children.push(new Paragraph({ style: 'Caption', children: [new TextRun({ text: cap[1], italics: true })] }));
        break;
      }
      children.push(new Paragraph({ children: inline(b.text) }));
      break;
    }
    case 'list': {
      b.items.forEach((it) => {
        const task = /^\[( |x)\] (.*)$/.exec(it.text);
        if (task) {
          children.push(new Paragraph({ indent: { left: 360, hanging: 300 }, spacing: { after: 60 }, children: [new TextRun({ text: task[1] === 'x' ? '☑ ' : '☐ ', size: 24, color: C.primary }), ...inline(task[2])] }));
        } else {
          children.push(
            new Paragraph({
              numbering: b.ordered ? { reference: 'ordinato', level: it.level, instance: b.inst } : { reference: 'puntato', level: it.level },
              spacing: { after: 60 },
              children: inline(it.text),
            }),
          );
        }
      });
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
      break;
    }
    case 'code': {
      const keep = b.lines.length <= 36;
      b.lines.forEach((l, k) => {
        children.push(
          new Paragraph({
            style: 'Codice',
            keepNext: keep && k < b.lines.length - 1,
            keepLines: true,
            children: [new TextRun({ text: l === '' ? ' ' : l })],
          }),
        );
      });
      children.push(new Paragraph({ spacing: { after: 100 }, children: [] }));
      break;
    }
    case 'table':
      children.push(table(b));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      break;
    case 'quote':
      children.push(callout(b.text));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      break;
    case 'images':
      children.push(images(b));
      break;
  }
}

// ---------- copertina ----------
const title = cover.find((c) => c.title)?.title ?? 'Manuale';
const coverTexts = cover.filter((c) => c.text).map((c) => c.text);
const [titleMain, titleSub] = title.split(' — ');
const coverChildren = [
  new Paragraph({ spacing: { before: 2400, after: 400 }, alignment: AlignmentType.LEFT, children: [imageRun(path.join(DOCS, '..', 'src/web/public/icon-512.png'), 110, 'Logo Ore Lavoro')] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: titleMain, bold: true, size: 84, color: C.head })] }),
  new Paragraph({ spacing: { after: 360 }, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: C.primary, space: 12 } }, children: [new TextRun({ text: titleSub ?? '', size: 40, color: C.ink })] }),
  ...coverTexts.map((t, k) => new Paragraph({ spacing: { before: k === 0 ? 300 : 80, after: 80 }, children: inline(t, { size: k === 0 ? 30 : 24, color: k === 0 ? C.ink : C.muted }) })),
  new Paragraph({ spacing: { before: 4200 }, children: [new TextRun({ text: 'Guida completa per utenti, amministratori e gestori tecnici: uso quotidiano, installazione sul NAS, manutenzione, backup e ripristino.', size: 20, color: C.muted })] }),
];

// ---------- documento ----------
const heading = (size, color, extra = {}) => ({ run: { font: 'Calibri', size, bold: true, color }, ...extra });
const doc = new Document({
  creator: 'Ore Lavoro',
  title: "Ore Lavoro — Manuale d'uso e di amministrazione",
  description: 'Manuale completo di Ore Lavoro',
  features: { updateFields: false },
  styles: {
    default: { document: { run: { font: 'Calibri', size: BODY, color: C.ink, language: { value: 'it-IT' } }, paragraph: { spacing: { after: 120, line: 276 } } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(40, C.head), paragraph: { spacing: { before: 120, after: 220 }, keepNext: true, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.primary, space: 6 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(28, C.ink), paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, ...heading(23, C.head), paragraph: { spacing: { before: 200, after: 80 }, keepNext: true, outlineLevel: 2 } },
      { id: 'Caption', name: 'Caption', basedOn: 'Normal', next: 'Normal', run: { size: 18, italics: true, color: C.muted }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 200 } } },
      {
        id: 'Codice',
        name: 'Codice',
        basedOn: 'Normal',
        run: { font: 'Courier New', size: 17, color: C.ink },
        paragraph: {
          spacing: { after: 0, line: 240 },
          indent: { left: 140, right: 140 },
          shading: { type: ShadingType.CLEAR, fill: C.codeBg, color: 'auto' },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.primary, space: 6 } },
        },
      },
    ],
  },
  numbering: {
    config: [
      {
        reference: 'puntato',
        levels: [0, 1, 2].map((l) => ({ level: l, format: LevelFormat.BULLET, text: ['•', '–', '·'][l], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + l * 360, hanging: 270 } } } })),
      },
      {
        reference: 'ordinato',
        levels: [0, 1, 2].map((l) => ({ level: l, format: LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + l * 360, hanging: 360 } } } })),
      },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: 1300, bottom: 1200, left: MARGIN, right: MARGIN } } },
      children: coverChildren,
    },
    {
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: 1300, bottom: 1200, left: MARGIN, right: MARGIN, header: 600, footer: 560 }, pageNumbers: { start: 1 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 4 } }, children: [new TextRun({ text: "Ore Lavoro — Manuale d'uso e di amministrazione", size: 17, color: C.muted })] })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Pagina ', size: 17, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 17, color: C.muted }), new TextRun({ text: ' di ', size: 17, color: C.muted }), new TextRun({ children: [PageNumber.TOTAL_PAGES_IN_SECTION], size: 17, color: C.muted })] })],
        }),
      },
      children,
    },
  ],
});

fs.writeFileSync(OUT, await Packer.toBuffer(doc));
console.log(`Creato ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${figure} gruppi di figure)`);
