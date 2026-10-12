/* ==========================================================================
   CSP 运行级验证（真 Chrome，双向证据）
   --------------------------------------------------------------------------
   为什么需要它：`test-parse.js` 里的 CSP 断言是**静态层**的 —— 它证明
   "策略字符串写对了"，但证明不了"浏览器真的按这个策略放行/拦截"。
   而 CSP 加错过一次的代价是全站白屏 / 图全裂 / 样式全丢，jsdom 又不执行 CSP。
   所以这一层必须用真 Chrome 跑，而且是**双向**的：

     正向  主题落地（head 内联脚本被哈希放行）、Service Worker 注册、
           demo 卡片渲染、内联 style 生效、抽屉开、服务端统计出、
           正常资源**零**违规
     反向  三个探针都必须被挡下：动态注入的内联脚本、外来域脚本、
           非白名单域的图片。没有这一条，"零违规"可能只是
           "CSP 根本没生效"的假绿。

   前置条件（缺任一项会明确报错，不静默跳过）：
     · 本机有 Chrome（默认路径 C:\Program Files\Google\Chrome\Application\chrome.exe，
       可用 --chrome 覆盖）
     · 能 require 到 playwright-core（用 --pw 指定路径；会自动探测几个常见位置）
     · 目标服务已在跑（默认 http://127.0.0.1:8799/，可用 --url 覆盖）

   运行：
     node tools/csp-verify.js
     node tools/csp-verify.js --url http://127.0.0.1:8787/ --chrome "D:\Chrome\chrome.exe"

   退出码：0 = 双向全部符合预期；1 = 有不符合项（明细打在 stdout）。
   这个脚本是**手工运行级验证工具**，不并进三个测试套件 —— 它依赖真 Chrome，
   而套件必须在任何机器上都能跑。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
const opt = (name, dft) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dft;
};
const URL = opt('url', 'http://127.0.0.1:8799/');
const CHROME = opt('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

/* ---------- 找 playwright-core ---------- */
const PW_CANDIDATES = [
  opt('pw', ''),
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
  'C:\\Users\\geral\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core',
].filter(Boolean);

let chromium = null;
for (const p of PW_CANDIDATES) {
  try {
    if (fs.existsSync(p) || require.resolve(p)) { chromium = require(p).chromium; break; }
  } catch { /* 换下一个候选 */ }
}
if (!chromium) {
  console.error('✗ 找不到 playwright-core。用 --pw <路径> 指定。');
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error('✗ 找不到 Chrome：' + CHROME + '（用 --chrome 指定）');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') problems.push('[console.' + t + '] ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
  page.on('requestfailed', (r) => {
    problems.push('[requestfailed] ' + r.url().slice(0, 80) + ' · ' + ((r.failure() || {}).errorText || '?'));
  });

  const results = [];
  const rec = (ok, label, detail) => { results.push({ ok, label, detail }); };

  try {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);          // 等启动探测 + loadMetrics 落盘

    /* ---------- 正向 ---------- */
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    rec(theme === 'light' || theme === 'dark',
      'head 内联主题脚本被执行（data-theme 已落地，哈希放行生效）', 'data-theme=' + theme);

    const sw = await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
    rec(sw === true, 'body 末尾的内联脚本执行了（Service Worker 已注册）', 'controller=' + sw);

    await page.evaluate(() => window.SXM.setDemo(true));
    await page.click('[data-demo="帮我买 AirPods Pro 3"]');
    await page.waitForTimeout(1800);

    const demo = await page.evaluate(() => {
      const s = document.getElementById('stream');
      const text = s ? s.innerText : '';
      return {
        badge: /演示数据/.test(text),
        styled: s ? s.querySelectorAll('[style]').length : -1,
        imgs: s ? [...s.querySelectorAll('img')] : []
      };
    });
    rec(demo.badge === true, 'demo 卡片渲染出来（含「演示数据」徽章）', 'styled=' + demo.styled);
    rec(demo.styled > 0, '卡片里有内联 style 属性的元素（style-src 放行了它们）',
      demo.styled + ' 个');
    rec(demo.imgs.every((i) => /^https:\/\//.test(i.getAttribute('src') || '')),
      '卡片里的图片地址全是 https（safeImg 的判据在真实渲染里成立）',
      demo.imgs.length + ' 张');

    await page.click('#btn-status');
    await page.waitForTimeout(1500);
    const drawer = await page.evaluate(() => {
      const d = document.getElementById('drawer-body');
      return {
        open: document.getElementById('drawer').classList.contains('open'),
        metrics: /服务端统计/.test(d ? d.innerText : '')
      };
    });
    rec(drawer.open === true, '抽屉能打开（drawer 渲染 + 焦点管理没被 CSP 破坏）', '');
    rec(drawer.metrics === true, '抽屉里出现「服务端统计」（/api/metrics 走得通，投影字段消费正常）', '');

    const clean = problems.filter((p) => !/Content Security Policy|Refused to/i.test(p));
    rec(clean.length === 0, '正常资源零报错（没有 pageerror / 请求失败）',
      clean.length ? clean.join(' | ') : '0 条');

    /* ---------- 反向：三个探针都必须被挡下 ---------- */
    await page.evaluate(() => {
      window.__inlineRan = false;
      window.__externalRan = false;
      const s1 = document.createElement('script');
      s1.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(s1);
      const s2 = document.createElement('script');
      s2.src = 'https://evil.example.com/probe.js';
      s2.onload = () => { window.__externalRan = true; };
      document.body.appendChild(s2);
      const img = document.createElement('img');
      img.src = 'https://not-allowed.example.com/probe.png';
      document.body.appendChild(img);
    });
    await page.waitForTimeout(1500);

    const probes = await page.evaluate(() => ({
      inlineRan: window.__inlineRan,
      externalRan: window.__externalRan,
      badImg: [...document.querySelectorAll('img')].some(
        (i) => /not-allowed\.example\.com/.test(i.src) && i.complete && i.naturalWidth > 0)
    }));
    rec(probes.inlineRan === false,
      '反向·动态注入的内联脚本被 script-src 挡下（没执行）', 'inlineRan=' + probes.inlineRan);
    rec(probes.externalRan === false,
      '反向·外来域脚本被 script-src 挡下（没加载）', 'externalRan=' + probes.externalRan);
    rec(probes.badImg === false,
      '反向·非白名单域的图片被 img-src 挡下（没加载）', 'badImg=' + probes.badImg);

    const violations = problems.filter((p) => /Content Security Policy|Refused to/i.test(p));
    rec(violations.length === 3,
      '反向·浏览器报出的 CSP 违规正好是这 3 个探针（一条不多一条不少）',
      violations.length + ' 条');

    /* ---------- 汇总 ---------- */
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
      console.log((r.ok ? '✓  ' : '✗  ') + r.label + (r.detail ? '　—— ' + r.detail : ''));
    }
    console.log('\nCSP 运行级验证：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
    if (violations.length) {
      console.log('\n浏览器报出的 CSP 违规原文：');
      violations.forEach((v) => console.log('  ' + v));
    }
    await browser.close();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('✗ 验证过程出错：' + e.message);
    await browser.close();
    process.exit(1);
  }
})();
