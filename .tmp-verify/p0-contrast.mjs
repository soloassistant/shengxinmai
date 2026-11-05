/* P0-1 断言：对比度全绿 + 热区。红/绿由真实渲染计算，不用 grep。
   用法：node .tmp-verify/p0-contrast.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
  const p = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\//, ''));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': (MIME[path.extname(p).toLowerCase()] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(8626, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:8626/index.html';
const port = 9760 + Math.floor(Math.random() * 40);
const udd = path.join(os.tmpdir(), 'p0-contrast-' + Date.now());
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${udd}`, '--window-size=375,667', 'about:blank'], { stdio: 'ignore' });
let pageWs = null;
for (let i = 0; i < 80 && !pageWs; i++) {
  await sleep(200);
  try { pageWs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* wait */ }
}
if (!pageWs) { console.error('no chrome'); process.exit(2); }
const ws = new WebSocket(pageWs);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.no(m.error) : p.ok(m.result); } });
const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; pend.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });

function scan() {
  const parse = (s) => { const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const blend = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const bgOf = (el) => {
    let acc = null, n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') return { unknown: true };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (acc.a >= 1) break; }
      n = n.parentElement;
    }
    if (!acc) return { r: 255, g: 255, b: 255, a: 1 };
    return acc.a < 1 ? blend(acc, { r: 255, g: 255, b: 255, a: 1 }) : acc;
  };
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[inert]')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; };
  const bad = [], hits = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const fs = parseFloat(cs.fontSize), fg = parse(cs.color), bg = bgOf(el);
      if (fg && !bg.unknown && !el.classList.contains('brand-mark')) {
        const need = (fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700)) ? 3 : 4.5;
        const r = ratio(blend(fg, bg), bg);
        if (r < need) bad.push({ t: el.textContent.trim().slice(0, 20), cls: (el.className || el.tagName).toString().slice(0, 24), fs, r: +r.toFixed(2), need });
      }
    }
    if (el.matches('button, a[href], input:not([type=hidden]), select, textarea')) {
      const r = el.getBoundingClientRect();
      const lab = el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
      const lr = lab ? lab.getBoundingClientRect() : null;
      const w = Math.max(r.width, lr ? lr.width : 0), h = Math.max(r.height, lr ? lr.height : 0);
      if (w < 44 || h < 44) hits.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 20), w: Math.round(w), h: Math.round(h) });
    }
  }
  return { bad, hits };
}

const states = [
  { n: 'shop', q: '帮我买 猫粮 10kg', act: null },
  { n: 'food', q: '想点个麻辣烫外卖', act: null },
  { n: 'route', q: '明天北京到上海的高铁', act: null },
  { n: 'status', q: '', act: 'status' },
  { n: 'watch', q: '', act: 'watch' },
  { n: 'dark-shop', q: '帮我买 猫粮 10kg', act: null, dark: true },
];
let fails = 0;
for (const st of states) {
  await ev(`localStorage.setItem('sxm.theme','${st.dark ? 'dark' : 'light'}')`);
  await send('Page.navigate', { url: BASE + (st.q ? '?q=' + encodeURIComponent(st.q) : '') });
  for (let i = 0; i < 60; i++) { await sleep(120); if (await ev('document.readyState==="complete" && !!window.SXM')) break; }
  await sleep(700);
  if (st.act === 'status') { await ev('window.SXM.openDrawer()'); await sleep(400); }
  if (st.act === 'watch') { await ev(`localStorage.setItem('sxm.watch',JSON.stringify([{q:'猫粮 10kg',qKey:'猫粮 10kg',platform:'jd',price:199,ts:Date.now()}]))`); await send('Page.navigate', { url: BASE }); await sleep(900); await ev('window.SXM.openDrawer()'); await sleep(400); }
  const r = await ev('(' + scan.toString() + ')()');
  console.log(st.n, 'contrast=' + r.bad.length, 'hits=' + r.hits.length);
  r.bad.forEach((b) => console.log('  C', b.cls, b.fs + 'px', b.r + ':1 need ' + b.need, '|', b.t));
  r.hits.forEach((h) => console.log('  H', h.tag, h.cls, h.w + 'x' + h.h));
  fails += r.bad.length + r.hits.length;
}
const sel = await ev(`(() => {
  const pick = (s) => { const el = document.querySelector(s); if (!el) return null; const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundColor }; };
  return { bubble: pick('.bubble-user'), go: pick('.go-brand'), tb: pick('.pf-tb'), off: pick('.plat-row .pf'), date: pick('.trip-line span') };
})()`);
console.log('selectors', JSON.stringify(sel));
try { child.kill('SIGKILL'); } catch { /* noop */ }
try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* noop */ }
server.close();
console.log(fails === 0 ? 'PASS contrast+hitarea' : 'FAIL ' + fails);
process.exit(fails === 0 ? 0 : 1);
