// Renders build/icon.png (256×256) with no image library: a dark disc, a
// green position arrow and a ring — the tray/taskbar mark for TarkovMap.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const N = 256;
const px = new Uint8Array(N * N * 4);

function put(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  const ia = a / 255, oa = px[i + 3] / 255;
  const na = ia + oa * (1 - ia);
  px[i] = Math.round((r * ia + px[i] * oa * (1 - ia)) / (na || 1));
  px[i + 1] = Math.round((g * ia + px[i + 1] * oa * (1 - ia)) / (na || 1));
  px[i + 2] = Math.round((b * ia + px[i + 2] * oa * (1 - ia)) / (na || 1));
  px[i + 3] = Math.round(na * 255);
}
const inTri = (p, a, b, c) => {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const cx = 128, cy = 128;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= 122) put(x, y, 11, 15, 20);
    if (d >= 104 && d <= 112) put(x, y, 70, 200, 120, 170);
    if (d >= 116 && d <= 122) put(x, y, 40, 120, 80);
    if (inTri([x, y], [128, 44], [186, 178], [128, 150])) put(x, y, 96, 240, 140);
    if (inTri([x, y], [128, 44], [70, 178], [128, 150])) put(x, y, 60, 180, 100);
  }
}
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(resolve(ROOT, "build"), { recursive: true });
writeFileSync(resolve(ROOT, "build", "icon.png"), png);
console.log("wrote build/icon.png");
