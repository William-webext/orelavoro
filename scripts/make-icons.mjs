// Genera le icone PNG della PWA (nessuna dipendenza): node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(import.meta.dirname, '../src/web/public');
fs.mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c;
  const table = (crc32.t ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// distanza da un segmento (per le lancette)
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Colore (r,g,b,a) del pixel normalizzato (u,v in 0..1). */
function shade(u, v, { maskable }) {
  // sfondo: sfumatura verticale; arrotondato se non maskable
  if (!maskable) {
    const r = 0.22;
    const cx = Math.min(Math.max(u, r), 1 - r);
    const cy = Math.min(Math.max(v, r), 1 - r);
    if (Math.hypot(u - cx, v - cy) > r) return [0, 0, 0, 0];
  }
  const g = v;
  let col = [14 + (8 - 14) * g, 116 + (88 - 116) * g, 144 + (110 - 144) * g, 255];
  const scale = maskable ? 0.72 : 1; // zona sicura per le icone maskable
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;
  const d = Math.hypot(x, y);
  const ring = d > 0.3 && d < 0.38;
  const hand1 = segDist(x, y, 0, 0, 0, -0.22) < 0.032; // lancetta lunga (ore)
  const hand2 = segDist(x, y, 0, 0, 0.15, 0.09) < 0.032; // lancetta corta
  const hub = d < 0.05;
  if (ring || hand1 || hand2 || hub) col = [255, 255, 255, 255];
  return col;
}

function render(size, opts) {
  const ss = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return png(size, buf);
}

const files = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  // iOS applica da solo gli angoli arrotondati: sfondo pieno
  ['apple-touch-icon.png', 180, { maskable: true }],
];
for (const [name, size, opts] of files) {
  fs.writeFileSync(path.join(out, name), render(size, opts));
  console.log('creato', name);
}
