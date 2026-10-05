/* ==========================================================================
   省心买 · 品牌资源生成器（PWA 图标 + 社交分享图）
   --------------------------------------------------------------------------
   为什么要有个生成器，而不是把 PNG 直接扔进仓库：
   图标是"设计的产物"，不是"手绘的产物"。手改一张 PNG 之后没人知道它对应
   哪个 SVG、改了哪儿。这里保证 **PNG 永远是 icon.svg 渲染出来的**，
   要改图标只改 SVG，再跑一次这个脚本。

   为什么用真浏览器渲染，而不是找 svg2png 一类库：
   本机实测没有可用的光栅化库（PIL / cairosvg / sharp 都没有），而 Chrome 就在本机。
   真浏览器渲染还有个额外好处 —— 拿到的就是用户真正会看到的那个像素结果，
   连带把 SVG 语法错误也一起验了（渲染失败会得到空白图，下面的断言能抓住）。

   依赖：本机装了 Chrome 或 Edge；能 require 到 playwright-core。
   这两个都不进 package.json 的 dependencies —— 线上跑服务用不到，
   放到 dependencies 里会白白让部署去装一个浏览器自动化库。

   用法（NODE_PATH 指向托管工作区的 node_modules）：
     NODE_PATH=<binaries>/node/workspace/node_modules node tools/gen-assets.js
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

/* 自己读 PNG 头核验尺寸。
   不用图像库是有意的：这是"产物级"断言，只认 PNG 自己写的 IHDR，
   不经过任何会替我们兜底的第三方代码。 */
function pngInfo(file) {
  const b = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (b[i] !== sig[i]) throw new Error(path.basename(file) + ' 不是合法 PNG（签名不对）');
  }
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const colorType = b[25]; // 6 = RGBA，2 = RGB，0 = 灰度
  // 真实性检查：一张"渲染失败"的图往往是纯色或全透明，字节数会异常小。
  return { w, h, colorType, bytes: b.length, hasAlpha: colorType === 6 };
}

const results = [];
function check(cond, msg) {
  results.push({ ok: !!cond, msg });
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + msg);
}

/* 把 PNG 的某个矩形区域铺到 canvas 上数像素。
   为什么要绕这一圈：断言如果只写"我版式是居中的"，那验的是我的意图；
   这里读的是**产物文件自己的像素**，版式哪天被改歪了它会真的变红。 */
async function pixelStats(page, buffer, rect) {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.setContent('<!doctype html><html><body style="margin:0"><img id="im" alt=""></body></html>');
  await page.evaluate(async (b64) => {
    const im = document.getElementById('im');
    im.src = 'data:image/png;base64,' + b64;
    await im.decode();
  }, buffer.toString('base64'));
  return page.evaluate((r) => {
    const im = document.getElementById('im');
    const c = document.createElement('canvas');
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
    let ink = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, sx = 0, sy = 0;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (y * r.w + x) * 4;
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum < 160) {
          ink++; sx += x; sy += y;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    return { ink, minx, maxx, miny, maxy, cx: ink ? sx / ink : 0, cy: ink ? sy / ink : 0, w: r.w, h: r.h };
  }, rect);
}

async function main() {
  const exe = findBrowser();
  if (!exe) throw new Error('本机没找到 Chrome / Edge，无法渲染图标');
  console.log('浏览器：' + exe);

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  const iconSvg = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');

  // 满幅版：把圆角去掉，交给系统自己裁（maskable / Apple 都要求这样）。
  // 保留圆角去当 maskable 会在被裁成圆形时露出圆角外的透明区。
  const maskSvg = iconSvg.replace('rx="112"', 'rx="0"');
  if (maskSvg === iconSvg) {
    throw new Error('满幅版替换失败：icon.svg 里找不到 rx="112"，别让图标悄悄退回圆角版');
  }

  async function shot(svg, size, file, { transparent }) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0;background:transparent}' +
      'svg{display:block;width:' + size + 'px;height:' + size + 'px}' +
      '</style></head><body>' + svg + '</body></html>',
      { waitUntil: 'load' }
    );
    const out = path.join(ROOT, file);
    await page.screenshot({ path: out, omitBackground: transparent, type: 'png' });
    return out;
  }

  console.log('\n— 图标（icon.svg 渲染） —');
  const icons = [
    ['icon-192.png', 192, iconSvg, true],
    ['icon-512.png', 512, iconSvg, true],
    ['favicon-32.png', 32, iconSvg, true],
    // Apple 会自己套圆角并自己裁边，所以给它不透明满幅方角版；
    // 给圆角版会变成"圆角套圆角"，四角露出底色。
    ['apple-touch-icon.png', 180, maskSvg, false],
    ['icon-maskable-512.png', 512, maskSvg, false],
  ];

  for (const [file, size, svg, transparent] of icons) {
    const out = await shot(svg, size, file, { transparent });
    const info = pngInfo(out);
    check(info.w === size && info.h === size,
      file + ' 尺寸是 ' + info.w + '×' + info.h + '（要 ' + size + '×' + size + '）');
    check(info.bytes > size * 4, file + ' 有内容（' + info.bytes + ' B，纯色/空图会小得多）');
    check(info.hasAlpha === transparent,
      file + (transparent ? ' 带透明通道' : ' 不透明（Apple/maskable 要求）'));
  }

  console.log('\n— 社交分享图（1200×630） —');
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(ogHtml(iconSvg), { waitUntil: 'load' });
  // 字体是异步加载的：不等它，截出来可能是回退字体（版式会悄悄变形）
  await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
  const ogBuf = await page.screenshot({ omitBackground: false, type: 'png' });
  const ogOut = path.join(ROOT, 'og-image.png');
  fs.writeFileSync(ogOut, ogBuf);

  const og = pngInfo(ogOut);
  check(og.w === 1200 && og.h === 630, 'og-image.png 尺寸是 ' + og.w + '×' + og.h + '（要 1200×630）');
  check(!og.hasAlpha, 'og-image.png 不透明（透明底在部分客户端会变黑）');
  check(og.bytes > 20000, 'og-image.png 不是空白（' + og.bytes + ' B）');

  /* 裁剪安全区：拿产物的真实像素来判，不拿我的版式意图来判。
     微信/QQ 把链接图的缩略图按**中间方形**裁 —— 所以内容必须落在中心 630×630 里，
     而且不能贴着裁剪边界（贴边就有被切掉的风险）。
     阈值取亮度 < 160 的"深色像素"，这样顶部那层暖色光晕（亮度约 233）不会干扰统计。 */
  const sq = { x: 285, y: 0, w: 630, h: 630 };
  const st = await pixelStats(page, ogBuf, sq);
  check(st.ink > 400, '中心方形里有内容（深色像素 ' + st.ink + ' 个）');
  check(st.ink > 400 && st.minx > 8,
    '中心方形裁剪后左边不会有内容被切掉（最左深色像素距边界 ' + st.minx + 'px）');
  check(st.ink > 400 && st.maxx < sq.w - 8,
    '中心方形裁剪后右边不会有内容被切掉（距右边界 ' + (sq.w - 1 - st.maxx) + 'px）');
  check(st.ink > 400 && st.miny > 8 && st.maxy < sq.h - 8,
    '中心方形裁剪后上下也留了余量（上 ' + st.miny + 'px / 下 ' + (sq.h - 1 - st.maxy) + 'px）');
  const dx = st.ink ? Math.abs(st.cx - (sq.w - 1) / 2) : 999;
  check(dx < 90, '内容横向居中（重心偏离中心 ' + Math.round(dx) + 'px）');

  // 不裁剪、整图铺满的客户端（浏览器标签页、部分 IM）也要留余量
  const full = await pixelStats(page, ogBuf, { x: 0, y: 0, w: 1200, h: 630 });
  check(full.minx > 8 && full.maxx < 1192,
    '整图左右也留了余量（左 ' + full.minx + 'px / 右 ' + (1199 - full.maxx) + 'px）');

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n结果：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
  if (failed.length) process.exit(1);
}

/* 分享图版式。
   两条硬约束，都是被真实裁剪行为逼出来的：

   1. **内容必须居中。** 1200×630 的图，到了微信/QQ 聊天窗里的缩略图基本是
      按**中间方形**裁的（约取中间 630×630）。第一版做成左对齐铺满，
      实测裁完"省心买"三个字被切掉一半 —— 只剩右边一片空白。
      居中是唯一能同时活过「1.91:1 整图」和「中心方形裁剪」两种用法的版式。
   2. **只讲一句话，且要短**。缩到 60px 的缩略图里，长句会糊成灰条。
      所以主标题之外只留一行品类，不放解释。
      主标题**每行不超过 6 个字**：中文按 1em/字 算，一行 12 字 × 62px ≈ 744px，
      比中心 630 的方形还宽 —— 实测就是这么被断言的抓到"左右两侧深色像素距边界 0px"。
      分行是硬约束，不是排版偏好。

   垂直方向也要卡住 630：所以下面的间距是手算过的，不是随便给的。 */
function ogHtml(iconSvg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{
    font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans SC",
                "Source Han Sans SC",sans-serif;
    background:
      radial-gradient(900px 620px at 50% -18%, #FFE2D6 0%, rgba(255,226,214,0) 64%),
      linear-gradient(135deg,#FFF8F5 0%,#FFFFFF 58%);
    color:#14181D;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;
  }
  .mark{width:96px;height:96px}
  .mark svg{display:block;width:96px;height:96px}
  .word{margin-top:18px;font-size:54px;font-weight:800;letter-spacing:3px;line-height:1}
  .sub{margin-top:12px;font-size:23px;font-weight:600;color:#8A8F98;letter-spacing:5px}
  .rule{height:5px;width:104px;border-radius:3px;margin:26px 0 24px;
        background:linear-gradient(90deg,#FF7A45,#FF4D2E)}
  h1{font-size:58px;font-weight:800;line-height:1.26;letter-spacing:1px}
  h1 em{font-style:normal;color:#FF4D2E}
  .tail{margin-top:26px;font-size:26px;font-weight:700;color:#6B7280;letter-spacing:1px}
  .tail b{color:#C8341A}
  </style></head><body>
  <div class="mark">${iconSvg}</div>
  <div class="word">省心买</div>
  <div class="sub">外卖 · 比价 · 出行</div>
  <div class="rule"></div>
  <h1>说一句人话，<br>我把该比的<br><em>都给你比了</em>。</h1>
  <div class="tail"><b>不代下单 · 不代支付</b> · 密钥只在服务端</div>
  </body></html>`;
}

main().catch((e) => {
  console.error('生成失败：' + (e && e.stack || e));
  process.exit(1);
});
