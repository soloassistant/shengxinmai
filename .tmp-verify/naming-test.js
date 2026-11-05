/* 第 4 笔 PR 的断言：只改名字，不造功能。
   跑法：node .tmp-verify/naming-test.js
   红：旧名字残留 / 新名字缺失 / AI、智能 无限定说明 / 分享按钮名不副实。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UI = ['index.html', 'app.js', 'manifest.json', 'README.md', 'package.json', 'manual-basket.js'];
const files = Object.fromEntries(UI.map((f) => [f, read(f)]));
const userFacing = UI.filter((f) => /\.(html|json|md|js)$/.test(f));
const all = Object.values(files).join('\n');

let bad = 0;
const ok = (label) => console.log('PASS ' + label);
const no = (label) => { bad++; console.log('FAIL ' + label); };

/* 1) 旧名字必须消失 */
const gone = [
  'AI 比价', 'AI比价', '智能比价', '智能推荐',
  '关注降价', '降价关注', '关注时最低', '已关注「',
  '>分享链接<', '分享链接</button>',
  '直达官方购票页', '官方页面下单',
];
for (const s of gone) {
  if (all.includes(s)) no(`旧名字仍残留：${s}`);
  else ok(`旧名字已消失：${s}`);
}

/* 2) 新名字必须存在 */
const need = [
  ['index.html', '省心买 · 比价与出行助手'],
  ['manifest.json', '"name": "省心买 · 比价与出行助手"'],
  ['README.md', '# 省心买 · 比价与出行助手'],
  ['app.js', '记下这件'],
  ['app.js', '记下的商品'],
  ['app.js', '复制链接'],
  ['README.md', '记下这件'],
  ['index.html', '机票走携程/去哪儿/飞猪'],
  ['README.md', '预订链接是携程/去哪儿/飞猪'],
  ['manifest.json', '机票走第三方购票入口'],
  ['manual-basket.js', '不含运费、满减与优惠券'],
];
for (const [f, s] of need) {
  if (files[f].includes(s)) ok(`新名字存在：${f} · ${s}`);
  else no(`新名字缺失：${f} · ${s}`);
}

/* 3) 反向断言：AI / 智能 若出现，同一行必须有「正则 / 解析 / 本地」限定。
       AI(?![A-Za-z]) 放过 CITY_AIR / RE_AIR 这类标识符。 */
const aiHits = [];
for (const f of userFacing) {
  files[f].split(/\r?\n/).forEach((line, i) => {
    if (/AI(?![A-Za-z])|智能/.test(line)) {
      aiHits.push({ f, line: i + 1, text: line.trim().slice(0, 80), qualified: /正则|解析|本地/.test(line) });
    }
  });
}
if (aiHits.length === 0) ok('全仓无「AI / 智能」称谓');
else {
  aiHits.forEach((h) => {
    if (h.qualified) ok(`AI 有限定说明：${h.f}:${h.line}`);
    else no(`AI / 智能 无限定说明：${h.f}:${h.line} ${h.text}`);
  });
}

/* 4) 「分享」改名必须名副其实：没有 navigator.share，就只能是复制链接 */
if (files['app.js'].includes('navigator.share')) {
  no('app.js 调用了 navigator.share，按钮却叫「复制链接」');
} else ok('未调用 navigator.share，按钮叫「复制链接」是准确的');
if (files['app.js'].includes('data-share')) ok('data-share 仍存在，复制链路没被改坏');
else no('data-share 消失，复制链路可能被改坏');

/* 5) manifest 仍是合法 JSON */
try {
  const m = JSON.parse(files['manifest.json']);
  if (m.name && m.short_name) ok('manifest.json 合法，name/short_name 存在');
  else no('manifest.json 缺 name/short_name');
} catch (e) { no('manifest.json 解析失败：' + e.message); }

console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}`);
process.exit(bad ? 1 : 0);
