// Generate the app icons (square, YellowGrid brand): #FFF500 field with three black bars
// rising left to right — no image libraries, raw PNG encoding via zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = draw(x, y, size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// three black bars rising left to right on brand yellow (interval/price motif)
const YELLOW = [255, 245, 0], BLACK = [18, 18, 18];
function draw(x, y, s) {
  const u = s / 512; // design in 512 units
  const bars = [
    { x0: 96, x1: 176, top: 296 },
    { x0: 216, x1: 296, top: 216 },
    { x0: 336, x1: 416, top: 136 },
  ];
  const base = 416;
  for (const b of bars) {
    if (x >= b.x0 * u && x < b.x1 * u && y >= b.top * u && y < base * u) return BLACK;
  }
  return YELLOW;
}

const out = path.join(__dirname, 'src', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const size of [180, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, draw));
  console.log(`icon-${size}.png written`);
}
