/**
 * 截图工具：用无依赖的方式在 Node 里渲染棋盘并导出 PNG。
 *
 * 为了不引入 node-canvas / skia 等原生依赖，这里内置一个极简的
 * Canvas2D 子集实现（只覆盖 drawBoard 用到的方法），并把结果写成 PNG。
 * 浏览器端运行的是标准 Canvas，这里只是“离屏预览/回归对比”用途。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { drawBoard } from '../src/board.js';
import { FILES, FRAME_ASPECT, RANKS } from '../src/geometry.js';

/* ------------------------------------------------------------------ *
 * 极简 Canvas2D 实现（仅支持 drawBoard 需要的 API）
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

class MiniCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4); // 全透明
    this._ctx = new MiniContext(this);
  }

  getContext() {
    return this._ctx;
  }
}

class MiniContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.font = '10px sans-serif';
    this.letterSpacing = undefined;
    this._stack = [];
    this._transform = { a: 1, d: 1, e: 0, f: 0 };
    /** 供 PNG 输出读取 */
    this.pixels = canvas.data;
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      font: this.font,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (s) Object.assign(this, s);
  }

  clearRect(x, y, w, h) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        this._setPixel(Math.round(x + i), Math.round(y + j), 0, 0, 0, 0);
      }
    }
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a] = parseColor(this.fillStyle);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        this._blend(Math.round(x + i), Math.round(y + j), r, g, b, a);
      }
    }
  }

  beginPath() {
    this._path = [];
  }

  moveTo(x, y) {
    this._path.push({ type: 'M', x, y });
  }

  lineTo(x, y) {
    this._path.push({ type: 'L', x, y });
  }

  stroke() {
    const [r, g, b, a] = parseColor(this.strokeStyle);
    const path = this._path ?? [];
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1];
      const p1 = path[i];
      if (p0.type === 'M' && p1.type === 'L') {
        this._strokeLine(p0.x, p0.y, p1.x, p1.y, r, g, b, a);
      }
    }
  }

  /** 带粗细的直线：沿主轴逐像素铺开 */
  _strokeLine(x0, y0, x1, y1, r, g, b, a) {
    const half = Math.max(this.lineWidth, 1) / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const steps = Math.ceil(len);
    const nx = -dy / len;
    const ny = dx / len;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      const w = Math.max(1, Math.round(this.lineWidth));
      for (let k = 0; k < w; k++) {
        const off = k - (w - 1) / 2;
        const px = Math.round(cx + nx * off);
        const py = Math.round(cy + ny * off);
        this._blend(px, py, r, g, b, a);
      }
      void half;
    }
  }

  /**
   * 文字：Node 端无系统字体栅格化能力，这里用“占位字块”表示。
   * 浏览器端会走真实 Canvas，因此不影响网页效果。
   */
  fillText(text, x, y) {
    const size = parseFontSize(this.font);
    const chars = [...String(text)];
    const step = size * 1.05;
    const total = step * chars.length;
    const [r, g, b, a] = parseColor(this.fillStyle);
    let cx = this.textAlign === 'center' ? x - total / 2 : x;
    for (let i = 0; i < chars.length; i++) {
      drawGlyphBox((px, py, rr, gg, bb, aa) => this._blend(px, py, rr, gg, bb, aa),
        cx, this.textBaseline === 'middle' ? y - size / 2 : y - size,
        size, r, g, b, a);
      cx += step;
    }
    void TAU;
  }

  _setPixel(x, y, r, g, b, a) {
    const { width, height, data } = this.canvas;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }

  _blend(x, y, r, g, b, a) {
    const { width, height, data } = this.canvas;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const sa = a / 255;
    const da = data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    data[i] = Math.round((r * sa + data[i] * da * (1 - sa)) / oa);
    data[i + 1] = Math.round((g * sa + data[i + 1] * da * (1 - sa)) / oa);
    data[i + 2] = Math.round((b * sa + data[i + 2] * da * (1 - sa)) / oa);
    data[i + 3] = Math.round(oa * 255);
  }
}

function drawGlyphBox(blend, x, y, size, r, g, b, a) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const w = Math.round(size);
  const h = Math.round(size);
  const t = Math.max(1, Math.round(size * 0.06));
  // 外框
  for (let i = 0; i < w; i++) {
    for (let k = 0; k < t; k++) {
      blend(x0 + i, y0 + k, r, g, b, a);
      blend(x0 + i, y0 + h - 1 - k, r, g, b, a);
    }
  }
  for (let j = 0; j < h; j++) {
    for (let k = 0; k < t; k++) {
      blend(x0 + k, y0 + j, r, g, b, a);
      blend(x0 + w - 1 - k, y0 + j, r, g, b, a);
    }
  }
  // 中横线，让占位字块可辨认
  for (let i = Math.round(w * 0.2); i < w * 0.8; i++) {
    for (let k = 0; k < t; k++) {
      blend(x0 + i, y0 + Math.round(h / 2) + k, r, g, b, a);
    }
  }
}

function parseFontSize(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? parseFloat(m[1]) : 10;
}

function parseColor(color) {
  const c = String(color).trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = [...hex].map((h) => h + h).join('');
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, hex.length === 8 ? (n & 255) : 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0, parts[3] == null ? 255 : Math.round(parts[3] * 255)];
  }
  return [0, 0, 0, 255];
}

/* ------------------------------------------------------------------ *
 * PNG 编码（RGBA8，filter 0）
 * ------------------------------------------------------------------ */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const out = resolve(args[0] ?? 'preview/board.png');
  const width = Number(args[1] ?? 1182);
  const height = Math.round(width * FRAME_ASPECT);

  const canvas = new MiniCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const layout = drawBoard(ctx, { width, height });

  const rgba = Buffer.from(canvas.data.buffer.slice(0));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePNG(canvas.width, canvas.height, rgba));

  console.log(`wrote ${out}  ${canvas.width}x${canvas.height}`);
  console.log(
    `board: ${FILES} 路 × ${RANKS} 线 = ${FILES * RANKS} 交叉点  ` +
      `每格 ${layout.filePitch.toFixed(1)}×${layout.rankPitch.toFixed(1)}px  ` +
      `线宽 ${layout.lineWidth.toFixed(2)}px`,
  );
}

main();
