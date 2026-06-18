#!/usr/bin/env node
/**
 * Generate the PureSignal app icon set with no third-party dependencies.
 *
 * The logo (ascending neon "signal" bars on a dark rounded tile) is drawn
 * straight into an RGBA buffer, then encoded to PNG (pure Node + zlib), packed
 * into a Windows .ico and a macOS .icns. Re-run any time the mark changes:
 *
 *   node scripts/gen-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = path.join(ROOT, "src-tauri", "icons");

/* Palette — mirrors src/styles.css. */
const BG = [10, 14, 20]; // #0a0e14
const BAR_TOP = [54, 224, 200]; // #36e0c8
const BAR_BOT = [106, 247, 168]; // #6af7a8

main().catch((e) => {
  console.error("✖ gen-icons failed:", e.message || e);
  process.exit(1);
});

async function main() {
  await mkdir(ICON_DIR, { recursive: true });

  // Cache one rendered+encoded PNG per pixel size.
  const cache = new Map();
  const png = (size) => {
    if (!cache.has(size)) cache.set(size, encodePng(drawLogo(size), size, size));
    return cache.get(size);
  };

  // PNGs referenced by tauri.conf.json (+ a 512 master).
  await writeFile(path.join(ICON_DIR, "32x32.png"), png(32));
  await writeFile(path.join(ICON_DIR, "128x128.png"), png(128));
  await writeFile(path.join(ICON_DIR, "128x128@2x.png"), png(256));
  await writeFile(path.join(ICON_DIR, "icon.png"), png(512));

  // Windows .ico (PNG-compressed entries; Vista+).
  const icoSizes = [16, 32, 48, 64, 128, 256];
  await writeFile(path.join(ICON_DIR, "icon.ico"), buildIco(icoSizes.map((s) => [s, png(s)])));

  // macOS .icns (PNG entries for modern slots).
  await writeFile(
    path.join(ICON_DIR, "icon.icns"),
    buildIcns([
      ["ic07", 128, png(128)],
      ["ic08", 256, png(256)],
      ["ic09", 512, png(512)],
      ["ic11", 32, png(32)],
      ["ic12", 64, png(64)],
      ["ic13", 256, png(256)],
      ["ic14", 512, png(512)],
    ])
  );

  console.log("✓ icons written to src-tauri/icons/ (png set, icon.ico, icon.icns)");
}

/* ------------------------------------------------------------------ */
/*  Logo drawing → RGBA buffer                                        */
/* ------------------------------------------------------------------ */

function drawLogo(size) {
  const buf = new Uint8Array(size * size * 4); // transparent by default

  const radius = size * 0.22; // rounded app-tile corners
  const inset = 0; // tile fills the icon

  // 1) Rounded dark tile.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRoundedRect(x + 0.5, y + 0.5, inset, inset, size - inset, size - inset, radius)) {
        setPx(buf, size, x, y, BG[0], BG[1], BG[2], 255);
      }
    }
  }

  // 2) Four ascending bars, centered, neon vertical gradient.
  const heights = [0.4, 0.62, 1.0, 0.52]; // fraction of usable height
  const n = heights.length;
  const usableW = size * 0.56;
  const left = (size - usableW) / 2;
  const gap = usableW * 0.08;
  const barW = (usableW - gap * (n - 1)) / n;
  const baseY = size * 0.74; // bars sit on this line
  const maxH = size * 0.46;
  const barRadius = barW * 0.32;

  for (let i = 0; i < n; i++) {
    const bx = left + i * (barW + gap);
    const bh = maxH * heights[i];
    const topY = baseY - bh;
    for (let y = Math.floor(topY); y < Math.ceil(baseY); y++) {
      for (let x = Math.floor(bx); x < Math.ceil(bx + barW); x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        // Rounded top corners on each bar.
        if (!insideRoundedRect(x + 0.5, y + 0.5, bx, topY, bx + barW, baseY, barRadius)) continue;
        const t = (baseY - y) / bh; // 0 at base → 1 at top
        const c = lerp3(BAR_BOT, BAR_TOP, clamp01(t));
        setPx(buf, size, x, y, c[0], c[1], c[2], 255);
      }
    }
  }

  return buf;
}

function insideRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
  const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function setPx(buf, size, x, y, r, g, b, a) {
  const i = (y * size + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp3 = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/* ------------------------------------------------------------------ */
/*  PNG encoder (RGBA, 8-bit)                                          */
/* ------------------------------------------------------------------ */

function encodePng(rgba, width, height) {
  // Raw image data: each scanline prefixed with a filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/*  ICO / ICNS containers (wrap PNG data)                             */
/* ------------------------------------------------------------------ */

function buildIco(entries) {
  // entries: [size, pngBuffer][]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach(([size, png], i) => {
    const d = i * 16;
    dir[d] = size >= 256 ? 0 : size; // 0 ⇒ 256
    dir[d + 1] = size >= 256 ? 0 : size;
    dir[d + 2] = 0; // palette
    dir[d + 3] = 0; // reserved
    dir.writeUInt16LE(1, d + 4); // planes
    dir.writeUInt16LE(32, d + 6); // bpp
    dir.writeUInt32LE(png.length, d + 8);
    dir.writeUInt32LE(offset, d + 12);
    offset += png.length;
    blobs.push(png);
  });

  return Buffer.concat([header, dir, ...blobs]);
}

function buildIcns(entries) {
  // entries: [ostype, size, pngBuffer][]
  const blocks = entries.map(([type, , png]) => {
    const head = Buffer.alloc(8);
    Buffer.from(type, "ascii").copy(head, 0);
    head.writeUInt32BE(png.length + 8, 4); // length includes the 8-byte header
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  Buffer.from("icns", "ascii").copy(head, 0);
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}
