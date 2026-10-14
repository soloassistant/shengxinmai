/* ==========================================================================
   运行级 E2E 验证（真 Chrome + 真 Service Worker，覆盖三个套件打不到的行为）
   --------------------------------------------------------------------------
   为什么需要它：`test-parse.js` 用 vm 桩子跑前端逻辑，桩子**没有 Service
   Worker、没有 Cache Storage、没有真实布局**。所以下面这些事情它证明不了：

     · SW 安装时**真的**把 12 项 SHELL 全预缓存了（v3 这次补了 3 张图标，
       补没补上只有真浏览器知道；桩子测的只是"清单字符串里有这几行"）
     · 旧版本缓存被 activate 清掉了、新版本名真的落地了
     · 零密钥时**一次 `/api/compare` 都不发**（桩子里的 fetch 是我自己垫的，
       "没调用"这件事在桩子里是自证的 —— 真浏览器里才是硬证据）
     · 发送键的禁用态在**真实输入事件**下跟着走
     · `h1.lead` 在真实 CSS 下算出来的对比度够不够 AA

   前置条件（缺任一项明确报错，不静默跳过）：
     · 本机有 Chrome（`--chrome` 可覆盖）
     · 能 require 到 playwright-core（`--pw` 可覆盖）
     · 目标服务已在跑（`--url` 可覆盖，默认 http://127.0.0.1:8787/）
       且必须是 **Node 形态**（`/api/health` 200）—— 纯静态 Pages 上
       「零密钥」这组断言没有意义（那边根本没有服务端，走的是同一条降级路径，
       但原因不同），本脚本会直接说明并退出，不产假绿。

   运行：
     node tools/e2e-verify.js --url http://127.0.0.1:8899/

   退出码：0 = 全通过；1 = 有不符合项；2 = 全局超时（防挂住）。

   注：每次 launch 都是**全新 profile**（Cache Storage 从零开始），所以
   "12 项全部落在 Cache Storage 里"验的是 SW 安装时真装进去了，不是上一轮的残留。
   （变异实验确认过：把清单删掉一项，实到数会跟着从 12 变成 11。）
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
const URL_BASE = opt('url', 'http://127.0.0.1:8787/');
const CHROME = opt('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

/* 防挂住：任何一步卡死也不让它无声吊着 */
const HARD = setTimeout(() => {
  console.error('✗ 全局超时（120s）—— 强制退出');
  process.exit(2);
}, 120000);

/* ---------- 从 sw.js 源码里抠出 VERSION / SHELL ----------
   不在本文件里重抄一遍清单：重抄等于"测试自己和自己一致"。
   先剥注释再匹配引号 —— 注释里写下的字面量会骗到正则（这个坑踩过）。 */
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const verM = /const\s+VERSION\s*=\s*'([^']+)'/.exec(SW_SRC);
const shellM = /const\s+SHELL\s*=\s*\[([\s\S]*?)\]/.exec(SW_SRC);
if (!verM || !shellM) {
  console.error('✗ 没能从 sw.js 里抠出 VERSION / SHELL（源码结构变了？）');
  process.exit(1);
}
const SW_VERSION = verM[1];
const SHELL = [...shellM[1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .matchAll(/'([^']+)'/g)].map((m) => m[1]);

/* SHELL 只许增不许减：如果谁把清单删短了，"全都预缓存了"会变成一句空话。
   这三张图标就是 v3 补的那次 —— 它们必须一直在。 */
const MUST_BE_SHELL = ['./icon-maskable-512.png', './favicon-32.png', './apple-touch-icon.png'];

/* 平台数也从 data.js 源码里抠（每条一个 url: 字段），不在脚本里写死 6 ——
   写死的话清单缩了脚本还绿，等于没钉。 */
const DATA_SRC = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
const spM = /const\s+SHOP_PLATFORMS\s*=\s*\[([\s\S]*?)\n\];/.exec(DATA_SRC);
if (!spM) { console.error('✗ 没能从 data.js 里抠出 SHOP_PLATFORMS'); process.exit(1); }
const N_PLATFORMS = (spM[1].match(/url\s*:/g) || []).length;
if (N_PLATFORMS < 4) {
  console.error('✗ 从 data.js 扣到 SHOP_PLATFORMS 只有 ' + N_PLATFORMS + ' 条 —— 扣法失效了，先修脚本');
  process.exit(1);
}

/* ---------- 找 playwright-core / Chrome ---------- */
const PW_CANDIDATES = [
  opt('pw', ''),
  path.join(__dirname, '..', 'node_modules', 'playwright-core'),
  'C:\\Users\\geral\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core'
].filter(Boolean);

let chromium = null;
for (const p of PW_CANDIDATES) {
  try { if (fs.existsSync(p) || require.resolve(p)) { chromium = require(p).chromium; break; } }
  catch { /* 换下一个候选 */ }
}
if (!chromium) { console.error('✗ 找不到 playwright-core。用 --pw <路径> 指定。'); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error('✗ 找不到 Chrome：' + CHROME + '（用 --chrome 指定）'); process.exit(1); }

/* ---------- 对比度（WCAG 相对亮度，和 test-parse 里同一套公式） ---------- */
const hex2rgb = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (rgb) => {
  const f = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => {
  const ra = hex2rgb(a); const rb = hex2rgb(b);
  if (!ra || !rb) return null;
  const l1 = lum(ra); const l2 = lum(rb);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const results = [];
  const rec = (ok, label, detail) => { results.push({ ok, label, detail: detail || '' }); };
  const problems = [];
  /* 请求计数：按路径分开记。零密钥那组断言要的正是"一次都没发"。 */
  const counts = { '/api/compare': 0, '/api/basket': 0, '/api/flights': 0, '/api/health': 0, '/api/metrics': 0 };

  const wire = (page) => {
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warning') problems.push('[console.' + t + '] ' + m.text());
    });
    page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
    page.on('requestfailed', (r) => problems.push('[requestfailed] ' + r.url().slice(0, 80) + ' · ' + ((r.failure() || {}).errorText || '?')));
    page.on('request', (r) => {
      try {
        const p = new (require('url').URL)(r.url()).pathname;
        if (counts[p] != null) counts[p]++;
      } catch { /* 非 http 请求忽略 */ }
    });
  };

  /* 等启动探测落定：serverOk 从 null 变 true 就意味着 probeOnce 跑完了，
     也意味着 HEALTH_CONFIGURED_COUNT 已经被写成真实值。
     不等这一步就查询，"零密钥短路"会因为探测还没回来而假红。 */
  const waitProbe = async (page) => {
    await page.waitForFunction(() => !!(window.SXM && window.SXM.serverOk === true), null, { timeout: 10000 });
  };

  try {
    const base = URL_BASE.replace(/\/$/, '');

    /* 先确认是 Node 形态 —— 纯静态站上这组断言没有意义，别产假绿 */
    const health = await fetch(base + '/api/health').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!health) {
      console.error('✗ ' + base + '/api/health 不是 200。本脚本要在 **Node 形态**（带服务端）上跑。');
      console.error('  先起服务：node server/server.js');
      await browser.close(); process.exit(1);
    }
    const configured = (health.adapters || []).filter((a) => a.configured).length;
    if (configured !== 0) {
      console.error('✗ 服务端当前 configuredCount=' + configured + '（不是 0）。');
      console.error('  「零密钥即时降级」这组断言需要在 0 密钥的形态下验，否则验的不是同一件事。');
      await browser.close(); process.exit(1);
    }

    /* ==================== A 加载 · SW v3 · 发送键 · h1 ==================== */
    const page = await browser.newPage();
    wire(page);
    await page.goto(URL_BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    /* SW 起来并接管（install 里 skipWaiting、activate 里 clients.claim） */
    const swState = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => (r.active ? r.active.state : 'none')));
    rec(swState === 'activated', 'Service Worker 注册并 activated', 'state=' + swState);

    let controller = null;
    for (let i = 0; i < 20; i++) {
      controller = await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
      if (controller) break;
      await page.waitForTimeout(250);
    }
    rec(controller === true, 'Service Worker 已接管本页（clients.claim 生效）', 'controller=' + controller);

    const cacheKeys = await page.evaluate(() => caches.keys());
    rec(cacheKeys.indexOf(SW_VERSION) !== -1,
      '缓存名是当前版本（' + SW_VERSION + '）且已建立', cacheKeys.join(', ') || '(空)');

    /* 预缓存齐全：逐项拿 SHELL 里的原样字符串去 cache 里找 */
    const precache = await page.evaluate(async (ver) => {
      const c = await caches.open(ver);
      const keys = await c.keys();
      return keys.map((r) => ({ url: r.url, path: new (window.URL)(r.url).pathname }));
    }, SW_VERSION);

    const missing = [];
    for (const item of SHELL) {
      const want = new (require('url').URL)(item, URL_BASE).pathname;
      if (!precache.some((k) => k.path === want)) missing.push(item);
    }
    rec(missing.length === 0,
      'SHELL 清单的 ' + SHELL.length + ' 项全部落在 Cache Storage 里',
      missing.length ? '缺：' + missing.join(' ') : '实到 ' + precache.length + ' 项');

    const shellMissing = MUST_BE_SHELL.filter((f) => SHELL.indexOf(f) === -1);
    rec(shellMissing.length === 0,
      'v3 补的三张图标仍在 SHELL 清单里（清单只许增不许减）',
      shellMissing.length ? '缺：' + shellMissing.join(' ') : '');

    /* v3 之前没有 v2 的残留（activate 清旧版本） */
    const stale = cacheKeys.filter((k) => /^sxm-shell-/.test(k) && k !== SW_VERSION);
    rec(stale.length === 0, '旧版本缓存已被 activate 清掉', stale.length ? '残留：' + stale.join(' ') : '');

    /* h1：语义层从 <p class="lead"> 改成了 <h1 class="lead">，且全局只有一个 h1 */
    const h1 = await page.evaluate(() => {
      const hs = [...document.querySelectorAll('h1')];
      return { n: hs.length, lead: hs.filter((x) => x.classList.contains('lead')).length, text: hs[0] ? hs[0].textContent.trim() : '' };
    });
    rec(h1.n === 1 && h1.lead === 1 && h1.text.length > 0,
      'h1.lead 存在且全文只有一个 h1（骨架正确）',
      'h1×' + h1.n + ' / text="' + h1.text.slice(0, 20) + '"');

    /* 发送键禁用态跟着真实 input 事件走 */
    const send0 = await page.evaluate(() => document.querySelector('button.send').disabled);
    await page.fill('#input', '帮我买 AirPods Pro 3');
    await page.waitForTimeout(120);
    const send1 = await page.evaluate(() => document.querySelector('button.send').disabled);
    await page.fill('#input', '');
    await page.waitForTimeout(120);
    const send2 = await page.evaluate(() => document.querySelector('button.send').disabled);
    rec(send0 === true && send1 === false && send2 === true,
      '发送键禁用态：空→禁用 / 有字→启用 / 清空→回禁用',
      [send0, send1, send2].join(' → '));

    /* ==================== B 零密钥比价：一次 /api/compare 都不发 ==================== */
    await waitProbe(page);
    const beforeB = counts['/api/compare'];
    await page.fill('#input', '帮我买 AirPods Pro 3');
    /* 发送键是 `<button disabled>`：playwright 的 actionability 检查会一直等它变成
       enabled，真坏掉时是**挂住 30s 然后抛异常**（汇总打不出来），不是一条干净的诊断。
       所以给点击一条兜底：超时就直接派发 submit 事件走同一条业务路径。
       兜底不改变断言强度 —— 发送键本身有独立的一条断言盯着。 */
    await page.click('button.send', { timeout: 3000 }).catch(() =>
      page.evaluate(() => document.getElementById('form')
        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))));
    await page.waitForTimeout(2600);
    const deltaB = counts['/api/compare'] - beforeB;
    rec(deltaB === 0, '零密钥时比价**一次 /api/compare 都没发**', '本阶段请求数=' + deltaB);

    const streamB = await page.evaluate(() => {
      const s = document.getElementById('stream');
      const ai = s ? [...s.querySelectorAll('.msg-ai')] : [];
      const last = ai.length ? ai[ai.length - 1] : null;
      return {
        ai: ai.length,
        links: last ? last.querySelectorAll('a.go').length : 0,
        prices: last ? last.querySelectorAll('.price').length : 0,
        whole: s ? s.textContent : ''
      };
    });
    rec(streamB.ai > 0 && streamB.links === N_PLATFORMS,
      '零密钥时出的是「手动比价」卡：' + N_PLATFORMS + ' 个平台入口一个不少',
      'msg-ai ' + streamB.ai + ' 个 / a.go ' + streamB.links + ' 个');
    rec(streamB.prices === 0 && !/演示数据/.test(streamB.whole),
      '手动比价卡里**没有任何价格数字**（「不编数据」那条硬约定）',
      '.price ' + streamB.prices + ' 个');

    /* ==================== C 演示模式：不打网络、带徽章 ==================== */
    const pageC = await browser.newPage();
    wire(pageC);
    const beforeC = counts['/api/compare'];
    await pageC.goto(URL_BASE + '?demo=1', { waitUntil: 'networkidle' });
    await pageC.waitForTimeout(2200);
    const demoC = await pageC.evaluate(() => {
      const s = document.getElementById('stream');
      const ai = s ? [...s.querySelectorAll('.msg-ai')] : [];
      const last = ai.length ? ai[ai.length - 1] : null;
      return {
        ai: ai.length,
        warn: last ? last.querySelectorAll('.banner-warn').length : 0,
        prices: last ? last.querySelectorAll('.price').length : 0,
        text: s ? s.textContent : ''
      };
    });
    rec(demoC.ai > 0 && demoC.warn > 0 && demoC.prices > 0 && /演示数据/.test(demoC.text),
      '?demo=1 直接出演示卡，带「演示数据 · 非实时」警示条与样例价格',
      'msg-ai ' + demoC.ai + ' / banner-warn ' + demoC.warn + ' / .price ' + demoC.prices);
    rec(counts['/api/compare'] - beforeC === 0,
      '演示模式不落后端（零 /api/compare）', '本阶段请求数=' + (counts['/api/compare'] - beforeC));
    await pageC.close();

    /* ==================== D 零密钥清单：不打 /api/basket，走 nokey 文案 ==================== */
    const pageD = await browser.newPage();
    wire(pageD);
    await pageD.goto(URL_BASE + '?open=basket', { waitUntil: 'networkidle' });
    await waitProbe(pageD);
    const beforeD = counts['/api/basket'];
    await pageD.fill('#basket-text', '扫地机器人\nAirPods Pro 3');
    await pageD.waitForTimeout(150);
    await pageD.click('#basket-go');
    await pageD.waitForTimeout(2200);
    const deltaD = counts['/api/basket'] - beforeD;
    rec(deltaD === 0, '零密钥时清单**一次 /api/basket 都没发**', '本阶段请求数=' + deltaD);

    const streamD = await pageD.evaluate(() => {
      const s = document.getElementById('stream');
      const ai = s ? [...s.querySelectorAll('.msg-ai')] : [];
      const last = ai.length ? ai[ai.length - 1] : null;
      return {
        ai: ai.length,
        links: last ? last.querySelectorAll('a.go').length : 0,
        text: s ? s.textContent : ''
      };
    });
    rec(streamD.ai > 0 && streamD.links === N_PLATFORMS * 2,
      '零密钥时出的是清单降级卡：2 件商品 × ' + N_PLATFORMS + ' 个平台入口都在（降级不缺能力）',
      'msg-ai ' + streamD.ai + ' / a.go ' + streamD.links);
    rec(/0 个数据源配了密钥/.test(streamD.text), '文案走的是「去配 key」而不是「去起服务端」', '');
    rec(!/没连上/.test(streamD.text), '没有把「0 密钥」错说成「没连上」（两条路给的动作相反）', '');
    await pageD.close();

    /* ==================== E 对比度：跑在真实 CSS 计算值上 ==================== */
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        bg: g('--bg'), surface: g('--surface'), surface2: g('--surface-2'), ink3: g('--ink-3')
      };
    });
    const pairs = [['--bg', vars.bg], ['--surface', vars.surface], ['--surface-2', vars.surface2]];
    const worst = pairs
      .map(([n, v]) => ({ n, r: contrast(vars.ink3, v) }))
      .filter((x) => x.r != null)
      .sort((a, b) => a.r - b.r)[0];
    rec(!!worst && worst.r >= 4.5,
      '--ink-3 落在真实底色上达到 WCAG AA（' + (vars.theme || '?') + ' 主题）',
      worst ? ('最差 ' + worst.n + ' = ' + worst.r.toFixed(2) + ':1') : '取不到颜色值');

    /* ==================== 通用：零 pageerror / 零失败请求 ==================== */
    const clean = problems.filter((p) => !/Failed to load resource.*404/.test(p));
    rec(clean.length === 0, '全程零 pageerror / 零请求失败',
      clean.length ? clean.slice(0, 3).join(' | ') + (clean.length > 3 ? ' …' : '') : '0 条');

    await page.close();

    /* ---------- 汇总 ---------- */
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
      console.log((r.ok ? '✓  ' : '✗  ') + r.label + (r.detail ? '　—— ' + r.detail : ''));
    }
    console.log('\n运行级 E2E：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
    console.log('请求计数：' + Object.entries(counts).map(([k, v]) => k + '=' + v).join('  '));
    clearTimeout(HARD);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('✗ 验证过程出错：' + e.message);
    clearTimeout(HARD);
    try { await browser.close(); } catch { /* 已经关了 */ }
    process.exit(1);
  }
})();
