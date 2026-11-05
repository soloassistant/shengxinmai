/* 第三笔 PR 的可复跑门禁：375×667 真浏览器里量三件事。
   1) 可见文字对比度（正文 ≥4.5:1，大字 ≥3:1）
   2) 字号 <12px 的可见文字数量（目标 0）
   3) 可点元素热区（宽、高均 ≥44px）
   用法：node .tmp-verify/a11y-probe.mjs [url]
   需要先起一个静态服务：node C:\...\bench-sxm\server-repo.mjs（端口 8623）。 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL0 = process.argv[2] || 'http://127.0.0.1:8623/index.html';
const W = 375, H = 667;
const port = 9500 + Math.floor(Math.random() * 100);
const udd = path.join(os.tmpdir(), 'a11y-probe-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 45000);
    });
  }
}

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

const AUDIT = `(function () {
  const parse = (s) => {
    const m = String(s).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    return m ? { r:+m[1], g:+m[2], b:+m[3], a:m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const bgOf = (el) => {
    let cur = el, acc = null, guard = 0;
    while (cur && guard++ < 40) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !acc) return null; // 渐变背景算不准，跳过
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? blend(acc, c) : c;
        if (c.a >= 1) return acc;
      }
      cur = cur.parentElement;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    return body && body.a >= 1 ? body : { r: 245, g: 246, b: 248, a: 1 };
  };
  const vis = (el, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
      && r.right > 0 && r.left < innerWidth;
  };
  const label = (el) => {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls + (t ? ' 「' + t + '」' : '');
  };

  const contrast = [], small = [], hits = [];
  walk(document.body);
  function walk(el) {
    const cs = getComputedStyle(el);
    if (!vis(el, cs)) return;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      const fg = parse(cs.color), bg = bgOf(el);
      if (fg && bg) {
        const fs = parseFloat(cs.fontSize);
        const bold = +cs.fontWeight >= 700;
        const large = fs >= 24 || (fs >= 18.66 && bold);
        const needRatio = large ? 3 : 4.5;
        const got = ratio(fg, bg);
        if (got < needRatio) contrast.push({ el: label(el), fs, ratio: +got.toFixed(2), need: needRatio, color: cs.color, bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' });
        if (fs < 12) small.push({ el: label(el), fs, text: (el.textContent || '').trim().slice(0, 30) });
      }
    }
    if (el.matches('button, a[href], input, textarea, select, [role="button"], [data-open], [data-fill]')) {
      const t = el.matches('input[type="checkbox"]') && el.closest('label') ? el.closest('label') : el;
      const r = t.getBoundingClientRect();
      if (vis(t, cs) && (r.width < 44 || r.height < 44)) {
        hits.push({ el: label(t), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    Array.from(el.children).forEach(walk);
  }
  const q = (s) => document.querySelectorAll(s).length;
  return { contrast, small, hits, viewport: innerWidth + 'x' + innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth : 0,
    counts: { go: q('.go'), chip: q('.chip'), retry: q('.retry'), copy: q('.copy-btn'), pf: q('.pf'),
      flRow: q('.fl-row'), drawer: document.querySelector('#drawer').className, basket: document.querySelector('#basket').className } };
})()`;

try {
  let ver;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch {}
    await sleep(100);
  }
  if (!ver) throw new Error('Chrome 没起来');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: URL0 });
  await sleep(1800);

  const js = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const runs = [];
  const audit = async (name) => {
    runs.push({ name, ...(await js(AUDIT)) });
  };

  await audit('首屏');
  await js(`document.querySelector('.cap[data-demo="帮我买 AirPods Pro 3"]').click()`);
  await sleep(900);
  await audit('比价结果');
  await js(`document.querySelector('.cap[data-demo="明天北京到上海的高铁"]').click()`);
  await sleep(700);
  await audit('出行结果');
  await js(`document.querySelector('.cap-wide').click()`);
  await sleep(350);
  await audit('清单抽屉');
  await js(`(() => { const t = document.querySelector('#basket-text');
    t.value = '猫粮\\n洗衣液\\nAirPods Pro 3';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#basket-go').click(); })()`);
  await sleep(1600);
  await audit('清单结果');
  await js(`document.querySelector('#basket-close').click()`);
  await js(`document.querySelector('#btn-status').click()`);
  await sleep(350);
  await audit('接入状态');

  let bad = 0;
  for (const r of runs) {
    const n = r.contrast.length + r.small.length + r.hits.length + (r.overflow ? 1 : 0);
    bad += n;
    console.log(`\n[${r.name}] 对比度 ${r.contrast.length} · 字号<12px ${r.small.length} · 热区 ${r.hits.length} · 横向溢出 ${r.overflow || 0} · 覆盖 ${JSON.stringify(r.counts)}`);
    if (r.contrast.length) console.log('  对比度:', JSON.stringify(r.contrast, null, 2));
    if (r.small.length) console.log('  小字:', JSON.stringify(r.small.map((x) => x.el + ' ' + x.fs + 'px'), null, 2));
    if (r.hits.length) console.log('  热区:', JSON.stringify(r.hits, null, 2));
  }
  console.log(`\n合计违规 ${bad}`);
  cleanup(bad ? 1 : 0);
} catch (e) {
  console.error('ERROR', e.message);
  cleanup(2);
}
