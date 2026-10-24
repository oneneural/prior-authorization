// Generates apps/web/app/favicon.ico, the editable source of that file: the
// pilot accent (#5b3cc4) as a rounded square with three white document lines,
// at 16x16 and 32x32 in 32-bit colour. Usage: node scripts/make-favicon.mjs
import { writeFileSync } from 'node:fs';

const ACCENT = [0x5b, 0x3c, 0xc4];
const WHITE = [0xff, 0xff, 0xff];
// On a 32-unit grid: [left, top, right] of each 3-unit-high line.
const LINES = [
  [8, 9, 24],
  [8, 15, 24],
  [8, 21, 18],
];
const RADIUS = 6;

/** One icon image: BITMAPINFOHEADER, bottom-up BGRA pixels, empty AND mask. */
function bitmap(size) {
  const scale = size / 32;
  const radius = RADIUS * scale;
  const insideSquare = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const onLine = (x, y) => LINES.some(([left, top, right]) => x >= left * scale && x < right * scale && y >= top * scale && y < (top + 3) * scale);

  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const [x, y] = [column + 0.5, row + 0.5];
      if (insideSquare(x, y)) {
        const [r, g, b] = onLine(x, y) ? WHITE : ACCENT;
        pixels.set([b, g, r, 0xff], ((size - 1 - row) * size + column) * 4);
      }
    }
  }

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // ICO bitmaps count the colour and mask rows together.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length, 20);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

const images = [16, 32].map((size) => ({ size, data: bitmap(size) }));
const directory = Buffer.alloc(6 + 16 * images.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach(({ size, data }, index) => {
  const entry = 6 + 16 * index;
  directory.writeUInt8(size, entry);
  directory.writeUInt8(size, entry + 1);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(data.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});

writeFileSync(new URL('../apps/web/app/favicon.ico', import.meta.url), Buffer.concat([directory, ...images.map(({ data }) => data)]));
