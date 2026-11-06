/* ==========================================================================
   省心买 · PNG8 量化（零依赖）
   --------------------------------------------------------------------------
   为什么自己写：分享图 218KB 的瓶颈不是"画得太复杂"，而是 Chrome 截图
   给的是 24 位真彩色 PNG —— 这张图实际只有约 3400 种颜色（大块纯色 +
   渐变 + 文字抗锯齿），真彩色纯属浪费。降到 256 色索引 PNG 就能减半，
   而代价必须可量化：**PSNR ≥ 35dB** 才算"肉眼看不出"。

   为什么不用现成库：仓库是零依赖的（线上服务不装任何 npm 包），
   生成器也守着这条；PNG 的 IHDR/PLTE/IDAT 三层结构 + zlib 是 Node 自带的，
   自己拼一遍比引一个图像库更可控 —— 也顺手能在断言里直接读产物。

   用法：require('./png8')，只给 gen-assets.js 用。
   ========================================================================== */
'use strict';

const zlib = require('node:zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------- 读：只认本项目会产出的那几种 PNG ----------
   截图（RGB / RGBA）与自己的量化产物（调色板）都要能读回来。
   不支持的格式直接抛错，别静默给出一张错图 —— 那会变成"看起来成功"的假绿。 */
function decode(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('不是合法 PNG（签名不对）');
  let p = 8, w = 0, h = 0, bit = 0, colorType = 0, interlace = 0;
  let palette = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bit = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bit !== 8 || interlace !== 0 || ![2, 3, 6].includes(colorType)) {
    throw new Error('不支持的 PNG：bit=' + bit + ' colorType=' + colorType + ' interlace=' + interlace);
  }
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = x >= bpp ? prev[x - bpp] : 0;
      const c = prev[x];
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += c;
      else if (ft === 3) v += Math.floor((a + c) / 2);
      else if (ft === 4) {
        const pa = Math.abs(c - b), pb = Math.abs(a - b), pc = Math.abs(a + c - 2 * b);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? c : b);
      } else if (ft !== 0) throw new Error('未知行过滤类型 ' + ft);
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  const rgb = Buffer.alloc(w * h * 3);
  if (colorType === 2) out.copy(rgb);
  else if (colorType === 6) {
    for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
      rgb[j] = out[i]; rgb[j + 1] = out[i + 1]; rgb[j + 2] = out[i + 2];
    }
  } else {
    for (let i = 0, j = 0; i < out.length; i++, j += 3) {
      const k = out[i] * 3;
      rgb[j] = palette[k]; rgb[j + 1] = palette[k + 1]; rgb[j + 2] = palette[k + 2];
    }
  }
  return { w, h, rgb };
}

/* ---------- 中位切分：按"出现次数加权"的区间二分 ----------
   纯按颜色空间切会把 256 个调色板格全花在渐变上，文字的抗锯齿灰阶反而
   被并掉。按像素权重切，等于按"这张图里真正占面积的颜色"分配配额。 */
function medianCut(rgb, maxColors) {
  const hist = new Map();
  for (let i = 0; i < rgb.length; i += 3) {
    const k = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const entries = [];
  for (const [k, n] of hist) {
    entries.push({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, n });
  }
  const boxOf = (es) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, t = 0;
    for (const e of es) {
      if (e.r < rmin) rmin = e.r; if (e.r > rmax) rmax = e.r;
      if (e.g < gmin) gmin = e.g; if (e.g > gmax) gmax = e.g;
      if (e.b < bmin) bmin = e.b; if (e.b > bmax) bmax = e.b;
      t += e.n;
    }
    return { es, rmin, rmax, gmin, gmax, bmin, bmax, t };
  };
  let boxes = [boxOf(entries)];
  while (boxes.length < maxColors) {
    let bi = -1, score = -1;
    for (let i = 0; i < boxes.length; i++) {
      const x = boxes[i];
      if (x.es.length < 2) continue;
      const range = Math.max(x.rmax - x.rmin, x.gmax - x.gmin, x.bmax - x.bmin);
      // 面积 × 颜色跨度：又大又花的块先切
      const s = range * Math.log2(x.t + 1);
      if (s > score) { score = s; bi = i; }
    }
    if (bi < 0) break;                       // 颜色数不足 256，就少用几个格
    const x = boxes[bi];
    const rg = x.rmax - x.rmin, gg = x.gmax - x.gmin, bg = x.bmax - x.bmin;
    const ch = rg >= gg && rg >= bg ? 'r' : gg >= bg ? 'g' : 'b';
    const es = x.es.slice().sort((a, b) => a[ch] - b[ch]);
    let acc = 0, cut = 0;
    for (let i = 0; i < es.length; i++) { acc += es[i].n; if (acc >= x.t / 2) { cut = i; break; } }
    cut = Math.min(Math.max(cut, 0), es.length - 2);   // 两边都必须非空
    boxes.splice(bi, 1, boxOf(es.slice(0, cut + 1)), boxOf(es.slice(cut + 1)));
  }
  return boxes.map((x) => {
    let r = 0, g = 0, b = 0, t = 0;
    for (const e of x.es) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; t += e.n; }
    return [Math.round(r / t), Math.round(g / t), Math.round(b / t)];
  });
}

/* ---------- 抖动 + 取最近色 ----------
   Floyd–Steinberg 蛇形扫描。为什么必须抖动：这张图的背景是渐变，
   256 色直接映射会出现可见色带 —— 而色带在 1200×630 的社交卡上就是
   "廉价感"的来源。抖动把量化误差摊成高频噪点，眼睛会把它平均掉。 */
function dither(rgb, w, h, palette) {
  const work = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) work[i] = rgb[i];
  const idx = new Uint8Array(w * h);
  const add = (x, y, er, eg, eb) => {
    const i = (y * w + x) * 3;
    work[i] += er; work[i + 1] += eg; work[i + 2] += eb;
  };
  for (let y = 0; y < h; y++) {
    const rev = y % 2 === 1;               // 蛇形扫描，避免误差只往一个方向堆
    for (let step = 0; step < w; step++) {
      const x = rev ? w - 1 - step : step;
      const i = (y * w + x) * 3;
      const r = work[i], g = work[i + 1], b = work[i + 2];
      let best = 0, bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dr = r - palette[k][0], dg = g - palette[k][1], db = b - palette[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = k; }
      }
      idx[y * w + x] = best;
      const er = r - palette[best][0], eg = g - palette[best][1], eb = b - palette[best][2];
      const s = rev ? -1 : 1;
      if (x + s >= 0 && x + s < w) add(x + s, y, er * 7 / 16, eg * 7 / 16, eb * 7 / 16);
      if (y + 1 < h) {
        if (x - s >= 0 && x - s < w) add(x - s, y + 1, er * 3 / 16, eg * 3 / 16, eb * 3 / 16);
        add(x, y + 1, er * 5 / 16, eg * 5 / 16, eb * 5 / 16);
        if (x + s >= 0 && x + s < w) add(x + s, y + 1, er / 16, eg / 16, eb / 16);
      }
    }
  }
  return idx;
}

/* ---------- 写 PNG8 ---------- */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length);
  return out;
}

function encode(idx, w, h, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3;            // 8 位、索引色
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    idx.slice(y * w, (y + 1) * w).forEach((v, x) => { raw[y * (w + 1) + 1 + x] = v; });
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* PSNR 是"肉眼看不看得出"的可量化替身：35dB 以上，渐变与文字边缘的
   误差都在人眼阈值之下；低于 30dB 就是肉眼可见的色带/糊边。 */
function psnr(origRgb, idx, palette) {
  let mse = 0;
  for (let i = 0, j = 0; i < origRgb.length; i += 3, j++) {
    const c = palette[idx[j]];
    const dr = origRgb[i] - c[0], dg = origRgb[i + 1] - c[1], db = origRgb[i + 2] - c[2];
    mse += dr * dr + dg * dg + db * db;
  }
  mse /= origRgb.length;
  return 10 * Math.log10((255 * 255) / mse);
}

function quantize(rgb, w, h, colors) {
  const palette = medianCut(rgb, colors || 256);
  const indices = dither(rgb, w, h, palette);
  return { indices, palette, psnr: psnr(rgb, indices, palette) };
}

module.exports = { decode, encode, quantize, psnr };
