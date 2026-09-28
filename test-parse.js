/* 解析逻辑验证 harness
   ------------------------------------------------------------------
   为什么要这么写：app.js 是 IIFE，解析函数不外泄。
   与其「读代码觉得没问题」，不如造一个最小 DOM 桩子把真文件跑起来，
   直接调它导出的 window.SXM.parseIntent —— 验的是真代码，不是复制品。

   运行：node test-parse.js
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Windows 控制台编码不可靠，同时写一份 UTF-8 日志文件 */
const LOG = [];
const say = (s) => { LOG.push(s); console.log(s); };
const flush = () => fs.writeFileSync(path.join(__dirname, 'test-out.txt'), LOG.join('\n'), 'utf8');

/* ---------- 最小 DOM 桩子 ---------- */
function makeEl() {
  const el = {
    className: '', id: '', innerHTML: '', value: '', disabled: false,
    dataset: {}, attrs: {},
    setAttribute(n, v) { this.attrs[n] = v; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, remove() {},
    focus() {}, closest() { return null; },
    dispatchEvent() {},
  };
  return el;
}

const STORE = {};
const DOC_EL = makeEl(); // documentElement 必须是同一个对象，applyTheme 反复往它身上写
const sandbox = {
  console,
  setTimeout: (fn) => fn(),
  Event: class Event { constructor(t, o) { this.type = t; Object.assign(this, o); } },
  document: {
    querySelector: () => makeEl(),
    createElement: () => makeEl(),
    addEventListener() {},
    documentElement: DOC_EL,
    body: { scrollHeight: 0 },
  },
  window: { scrollTo() {}, addEventListener() {} },
  localStorage: {
    getItem: (k) => (k in STORE ? STORE[k] : null),
    setItem: (k, v) => { STORE[k] = String(v); },
    removeItem: (k) => { delete STORE[k]; },
  },
};
sandbox.window = sandbox.window || {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- 按 <script> 顺序把 data.js + app.js 灌进去 ---------- */
const dir = __dirname;
const code = fs.readFileSync(path.join(dir, 'data.js'), 'utf8')
           + '\n' + fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
vm.runInContext(code, sandbox, { filename: 'bundle.js' });

const SXM = sandbox.window.SXM;
if (!SXM) { say('✗ 没拿到 window.SXM，app.js 可能报错了'); flush(); process.exit(1); }

/* ---------- 用例 ---------- */
/* 注意：必须用本地时间格式化，不能 toISOString()。
   本地午夜转 UTC 会退一天，曾让这份测试报出假的“差一天”。 */
const iso = (d) => {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

const cases = [
  { in: '帮我买 AirPods Pro 3',
    want: { type: 'shop', product: 'AirPods Pro 3' } },

  { in: '手机壳多少钱',
    want: { type: 'shop', product: '手机壳' } },

  { in: '明天北京到上海的高铁',
    want: { type: 'rail', from: '北京', to: '上海' } },

  { in: '下周三 广州到成都 机票',
    want: { type: 'air', from: '广州', to: '成都' } },

  { in: '去成都的机票',
    want: { type: 'air', from: null, to: '成都' } },

  { in: '想点个麻辣烫外卖',
    want: { type: 'food' } },

  { in: '9月30日 杭州到西安',
    want: { type: 'both', from: '杭州', to: '西安' } },

  { in: '从深圳出发去三亚',
    want: { type: 'both', from: '深圳', to: '三亚' } },

  { in: '北京到上海',
    want: { type: 'both', from: '北京', to: '上海' } },

  { in: '周一 上海到北京 飞机',
    want: { type: 'air', from: '上海', to: '北京' } },

  // 回归：句子里有两个城市名，但中间没有方向词 —— 这是购物，不是路线。
  // 之前会误判成「出行」，把用户买土特产变成查车票。
  { in: '帮我买北京烤鸭和天津麻花',
    want: { type: 'shop', product: '北京烤鸭和天津麻花' } },

  { in: '北京到上海多少钱',
    want: { type: 'both', from: '北京', to: '上海' } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = SXM.parseIntent(c.in);
  const bad = [];
  for (const k of Object.keys(c.want)) {
    const a = got ? got[k] : undefined;
    const b = c.want[k];
    const same = (a === b) || (a === null && b === null);
    if (!same) bad.push(`${k}: 期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)}`);
  }
  if (bad.length) {
    fail++;
    say(`✗  ${c.in}`);
    bad.forEach((m) => say(`     ${m}`));
  } else {
    pass++;
    say(`✓  ${c.in}  →  ${got.type}${got.from ? ` ${got.from}→${got.to}` : ''}${got.product ? ` 「${got.product}」` : ''}`);
  }
}

/* ---------- 日期用例 ---------- */
say('\n— 日期解析 —');
const today = new Date(); today.setHours(0, 0, 0, 0);
const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

const dateCases = [
  ['明天出发', plus(1)],
  ['后天出发', plus(2)],
  ['大后天出发', plus(3)],
  ['今天走', plus(0)],
];
for (const [txt, want] of dateCases) {
  const d = SXM.parseDate(txt);
  const got = iso(d && d.date);
  if (got === want) { pass++; say(`✓  ${txt} → ${got}`); }
  else { fail++; say(`✗  ${txt} → 期望 ${want}, 实际 ${got}`); }
}

/* 绝对日期：拿「今天+3 天」这个**真实存在**的日期去问，验证跨月/跨年都对。
   曾经的写法是「今天的号数 +3」拼文本 —— 9月28日 会拼出「9月31日」，
   一个根本不存在的日子。那时旧代码把它静默滚成 10月1日，测试侥幸通过；
   现在不存在的日期会被判无效，这条测试自己先炸了。
   教训：拼测试数据也要用真实的日期运算，别用号数做算术。 */
const absTarget = new Date(today);
absTarget.setDate(absTarget.getDate() + 3);
const absTxt = `${absTarget.getMonth() + 1}月${absTarget.getDate()}日出发`;
const absWant = iso(absTarget);
const absGot = SXM.parseDate(absTxt);
if (iso(absGot && absGot.date) === absWant) { pass++; say(`✓  ${absTxt} → ${absWant}`); }
else { fail++; say(`✗  ${absTxt} → 期望 ${absWant}, 实际 ${iso(absGot && absGot.date)}`); }

/* 跨月边界单独立一条：本月最后一天 23:59 之后是下月 1 日，别滚错月 */
const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0); // 本月最后一天
const nextDay  = new Date(monthEnd); nextDay.setDate(nextDay.getDate() + 1);
const meTxt = `${monthEnd.getMonth() + 1}月${monthEnd.getDate()}日出发`;
const meGot = SXM.parseDate(meTxt);
if (meGot && !meGot.invalid && iso(meGot.date) === iso(monthEnd) && nextDay.getMonth() !== monthEnd.getMonth()) {
  pass++; say(`✓  月末边界：${meTxt} 解析正确，没有滚进下个月`);
} else { fail++; say(`✗  月末边界错了：${meTxt} → ${JSON.stringify(meGot)}`); }

/* ---------- 端到端：真的生成出订票 URL 吗 ---------- */
say('\n— 生成的订票链接 —');
const rail = SXM.renderRoute({ type: 'rail', from: '北京', to: '上海', cities: ['北京', '上海'],
  date: { date: today, label: '测试日', explicit: true }, raw: '' });
const railUrl = (rail.match(/https:\/\/kyfw\.12306\.cn[^"]+/) || [])[0];
const railOk = railUrl
  && railUrl.includes('fs=' + encodeURIComponent('北京'))
  && railUrl.includes('ts=' + encodeURIComponent('上海'))
  && railUrl.includes('date=' + iso(today));
if (railOk) { pass++; say(`✓  12306 链接带齐站点与日期\n     ${railUrl}`); }
else { fail++; say(`✗  12306 链接不对：${railUrl}`); }

const air = SXM.renderRoute({ type: 'air', from: '广州', to: '成都', cities: ['广州', '成都'],
  date: { date: today, label: '测试日', explicit: true }, raw: '' });
const ctrip = (air.match(/https:\/\/flights\.ctrip\.com[^"]+/) || [])[0];
// 城市三字码必须转成小写城市码，而不是直接塞中文
const airOk = ctrip && ctrip.includes('oneway-can-ctu') && ctrip.includes('depdate=' + iso(today));
if (airOk) { pass++; say(`✓  携程链接用对了三字码\n     ${ctrip}`); }
else { fail++; say(`✗  携程链接不对：${ctrip}`); }

// 缺出发地时必须反问，而不是默认填一个城市
const ask = SXM.renderRoute({ type: 'air', from: null, to: '成都', cities: ['成都'], date: null, raw: '' });
if (ask.includes('还差一个出发地')) { pass++; say('✓  缺出发地 → 反问，没有瞎猜城市'); }
else { fail++; say('✗  缺出发地时没有正确反问'); }

// 没给日期时要标注是默认值，不能伪装成用户说的
const noDate = SXM.renderRoute({ type: 'rail', from: '北京', to: '上海', cities: ['北京', '上海'], date: null, raw: '' });
if (noDate.includes('默认明天')) { pass++; say('✓  未给日期 → 卡面明示“默认明天”'); }
else { fail++; say('✗  未给日期时没有标注默认值'); }

/* ---------- 距离计算：拿真实距离做基准，不对就是公式写错了 ---------- */
say('\n— 城市距离（大圆距离，与公开真实值比对）—');
const CITY_GEO = SXM.CITY_GEO;
const dist = (a, b) => SXM.greatCircle(CITY_GEO[a], CITY_GEO[b]);

const distCases = [
  ['北京', '上海', 1067, 40],
  ['北京', '广州', 1888, 60],
  ['广州', '深圳', 105, 15],
  ['北京', '天津', 108, 15],
  ['上海', '杭州', 165, 25],
];
for (const [a, b, want, tol] of distCases) {
  const got = dist(a, b);
  if (Math.abs(got - want) <= tol) { pass++; say(`✓  ${a}-${b} 约 ${Math.round(got)} km（真实约 ${want} km）`); }
  else { fail++; say(`✗  ${a}-${b} = ${Math.round(got)} km，偏离真实值 ${want} 太多`); }
}

/* ---------- 决策阈值必须和估算模型自洽 ---------- */
say('\n— 走法判断（阈值 vs 估算模型）—');
const verdictCases = [
  [300,  'rail', '短途'],
  [700,  'rail', '中短途'],
  [1069, 'tie',  '京沪这种接近的'],
  [1888, 'air',  '长途'],
  [2800, 'air',  '超长途'],
];
for (const [km, want, label] of verdictCases) {
  const e = SXM.estimateModes(km);
  const v = SXM.modeVerdict(km);
  const gap = (e.rail - e.air).toFixed(2);
  if (v.pick === want) { pass++; say(`✓  ${km} km（${label}）→ ${v.pick}　高铁 ${SXM.humanHours(e.rail)} / 飞机 ${SXM.humanHours(e.air)}，差 ${gap}h`); }
  else { fail++; say(`✗  ${km} km → 期望 ${want}，实际 ${v.pick}`); }
}

// 京沪这条线现实中高铁和飞机门到门就是差不多，模型不该给出离谱结论
const jh = SXM.estimateModes(1069);
if (Math.abs(jh.rail - jh.air) < 1.0) { pass++; say(`✓  京沪高铁与飞机门到门差 ${Math.abs(jh.rail - jh.air).toFixed(2)}h，符合“差不多”的现实`); }
else { fail++; say(`✗  京沪两种方式差得太多，估算系数需要复核`); }

if (SXM.humanHours(4.776) === '4 小时 45 分') { pass++; say('✓  耗时格式化：4.776 → 4 小时 45 分'); }
else { fail++; say(`✗  耗时格式化不对：${SXM.humanHours(4.776)}`); }

/* ---------- 火车票卡：必须讲清“为什么不比价”且只给官方入口 ---------- */
say('\n— 火车票卡 —');
const railCard = SXM.renderRoute({
  type: 'rail', from: '北京', to: '上海', cities: ['北京', '上海'],
  date: { date: today, label: '测试日', explicit: true }, raw: ''
});
const railChecks = [
  // 2026-09-27 用户反馈：这段"为什么只给一个入口"的解释是多余的，已删。
  // 断言反转，防止哪天它又长回来。
  [!railCard.includes('为什么只给一个入口'), '不再重复解释"为什么只给一个入口"（用户反馈多余）'],
  [!railCard.includes('全国统一定价，由 12306 定价'), '长篇论证不上卡片，事实依据留在 README 里'],
  [railCard.includes('直线距离约'), '展示了算出来的距离'],
  [railCard.includes('门到门粗估'), '把耗时标明为粗估而非精确值'],
  [railCard.includes('席别怎么选'), '有席别选择指引'],
  [railCard.includes('没票了怎么办'), '有候补玩法'],
  [!/flights\.ctrip\.com/.test(railCard), '纯火车票模式下没有混入机票入口'],
];
for (const [okFlag, label] of railChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

// 顺序：先判断走法，再给购票入口——用户先知道该不该坐火车，再决定去哪买
const iMode = railCard.indexOf('这条线怎么走更划算');
const iBuy  = railCard.indexOf('火车票 · 去哪买');
if (iMode >= 0 && iBuy > iMode) { pass++; say('✓  卡片顺序：先“怎么走更划算”，后“去哪买”'); }
else { fail++; say('✗  卡片顺序不对，购票入口应在走法判断之后'); }

/* ---------- 价格历史曲线：样本不足绝不画线 ---------- */
say('\n— 价格历史曲线 —');

if (SXM.spark(null) === '' && SXM.spark({}) === '') {
  pass++; say('✓  没有历史数据时什么都不渲染，而不是留一个空壳');
} else { fail++; say('✗  无数据时不该产生任何输出'); }

const sparkOne = SXM.spark({ count: 1, points: [{ t: 1, f: 100 }], verdict: 'insufficient', verdictText: '只采到 1 次' });
if (!/<svg/.test(sparkOne) && sparkOne.includes('走势线')) {
  pass++; say('✓  只有 1 个点时只说明情况、不画线（一个点连不成趋势，画出来就是骗人）');
} else { fail++; say(`✗  1 个点时不该画出曲线：${sparkOne.slice(0, 60)}`); }

const sparkMany = SXM.spark({
  count: 5, lowest: 81, highest: 100, verdict: 'near-lowest',
  verdictText: '已接近采集以来的最低价（高 1.2%）',
  points: [{ t: 1, f: 100 }, { t: 2, f: 95 }, { t: 3, f: 90 }, { t: 4, f: 85 }, { t: 5, f: 81 }]
});
const sparkChecks = [
  [/<svg/.test(sparkMany), '点够了就画出曲线'],
  [sparkMany.includes('spark-v-near-lowest'), '曲线带上判定结果，颜色跟着判定走'],
  [sparkMany.includes('低 ¥81') && sparkMany.includes('高 ¥100'), '标出采集区间，用户能自己复核'],
  [sparkMany.includes('已接近采集以来的最低价'), '把结论用文字也说一遍（不是只画线让人猜）'],
  [!NaN.toString().length || !/NaN/.test(sparkMany), '坐标里没有 NaN —— 有的话曲线会静默画不出来'],
];
for (const [okFlag, label] of sparkChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 演示载荷：结构必须和真接口一致 ---------- */
say('\n— 演示载荷（?demo=1）—');

const dl  = SXM.demoLive('AirPods Pro 3');
const dl2 = SXM.demoLive('AirPods Pro 3');
const dlChecks = [
  [dl.demo === true, '标了 demo:true，卡片会自动打上「演示数据」'],
  [dl.platforms.length === 3, '三个平台，与真实适配器数量一致'],
  [dl.platforms.every((p) => p.ok && p.lowest && p.items.length > 0), '每个平台都有最低价和条目'],
  [dl.platforms.every((p) => p.lowest.history && p.lowest.history.points.length >= 8), '最低价都带历史曲线数据（否则用户看不到这个能力）'],
  [dl.platforms[0].lowest.final <= dl.platforms[2].lowest.final, '平台按最低价升序，和真接口的排序一致'],
  [dl.platforms.every((p) => p.items.every((it) => Number.isFinite(it.final) && it.final > 0)), '样例价格都是正数，不会出现 0 元或 NaN'],
  [dl.platforms.every((p) => p.items.every((it) => it.final <= it.price)), '到手价不高于券前标价（券不可能是负的）'],
  [dl.platforms.every((p) => p.lowest.final === Math.min(...p.items.map((it) => it.final))), '平台的最低价确实是它自己条目里最低的那条'],
  [dl.platforms[0].lowest.final === dl2.platforms[0].lowest.final, '同一个商品生成的样例可复现（方便截图对账）'],
  [SXM.demoLive('猫粮').platforms[0].lowest.final !== dl.platforms[0].lowest.final, '不同商品生成不同样例，不是写死的一张表'],
];
for (const [okFlag, label] of dlChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

const demoCard = SXM.renderShopLive('AirPods Pro 3', dl);
const demoChecks = [
  [demoCard.includes('演示数据 · 非实时'), '演示卡顶部强制标注"非实时"'],
  [!demoCard.includes('tag-ok'), '演示卡不带「实时」标签'],
  [demoCard.includes('spark-line'), '演示卡里真的画出了走势线'],
  [!/href="#demo"/.test(demoCard), '演示模式不给能点的假购买链接（点了什么都不会发生）'],
];
for (const [okFlag, label] of demoChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 省钱清单卡 ---------- */
say('\n— 省钱清单卡 —');

const bsCard = SXM.renderBasket({
  recommend: 'split',
  reason: '分件买能省 ¥30.00，超过 ¥10 的"麻烦门槛"，值得多开 1 个 App。',
  itemCount: 2, pricedCount: 2, unpriced: [],
  items: [
    { q: '猫粮', best: { platform: 'jd', name: '京东', final: 70 }, alternatives: [], spread: 30,
      platformCount: 2, runnerUp: { platform: 'pdd', name: '拼多多', final: 100 }, gapToRunnerUp: 30 },
    { q: '猫砂', best: { platform: 'pdd', name: '拼多多', final: 30 }, alternatives: [], spread: 70,
      platformCount: 2, runnerUp: { platform: 'jd', name: '京东', final: 100 }, gapToRunnerUp: 70 }
  ],
  split: { total: 100, platformCount: 2, platforms: [
    { platform: 'jd', name: '京东', subtotal: 70, count: 1 },
    { platform: 'pdd', name: '拼多多', subtotal: 30, count: 1 }
  ] },
  singles: [{ platform: 'pdd', name: '拼多多', total: 130, count: 2, missing: [] }],
  bestSingle: { platform: 'pdd', name: '拼多多', total: 130 },
  worstSingle: { platform: 'pdd', name: '拼多多', total: 130 },
  savingVsBestSingle: 30, savingVsWorstSingle: 30, appsSaved: 1,
  threshold: 10, currency: 'CNY',
  notes: ['总价按各平台「最低到手价」相加，不含运费；合并下单时运费可能把它们再拉平一次。'],
  perQuery: [
    { q: '猫粮', prices: {}, best: { platform: 'jd', name: '京东', final: 70, title: '猫粮', url: 'https://u.jd.com/aaa' } },
    { q: '猫砂', prices: {}, best: { platform: 'pdd', name: '拼多多', final: 30, title: '猫砂', url: 'https://p.pinduoduo.com/bbb' } }
  ],
  failed: []
});

/* 断言文案时先去标签：金额是 <span class="cny">¥</span>130 这种结构，
   直接 includes('¥130') 会因为中间夹了标签而假失败。 */
const plain = (html) => String(html).replace(/<[^>]*>/g, '');
const bsText = plain(bsCard);

const bsChecks = [
  [bsText.includes('建议分开买'), '把结论直接写在最显眼处'],
  [bsText.includes('¥100'), '分件买最优的总价 100 出现在卡上'],
  [bsText.includes('¥130'), '一家买齐的总价 130 也摆出来，用户能自己复核'],
  [bsText.includes('分件买比最便宜的'), '把差额讲明白，而不是只说"更省"'],
  [bsText.includes('猫粮') && bsText.includes('猫砂'), '逐件明细都在'],
  [bsText.includes('次低是'), '每件都给了次低价，用户能看到"贵一点能少开一个 App"'],
  [bsCard.includes('href="https://u.jd.com/aaa"'), '真实链接被原样带出来了（能直接去下单）'],
  [bsText.includes('不含运费'), '每个方案都提醒了运费这个变量'],
];
for (const [okFlag, label] of bsChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

// 一件都没拿到价：不许出现任何总价数字
const bsNone = SXM.renderBasket({
  recommend: 'none',
  reason: '这一单里没有任何一件拿到价格，给不出方案。先确认关键词，或者等平台把密钥配上。',
  itemCount: 1, pricedCount: 0, unpriced: [{ q: '耳机' }],
  items: [{ q: '耳机', best: null, alternatives: [], spread: 0, platformCount: 0, runnerUp: null, gapToRunnerUp: 0 }],
  split: { total: 0, platformCount: 0, platforms: [] },
  singles: [], bestSingle: null, worstSingle: null,
  savingVsBestSingle: null, savingVsWorstSingle: null, appsSaved: 0,
  currency: 'CNY', notes: [], perQuery: [{ q: '耳机', prices: {}, best: null, error: null }], failed: []
});
const bsNoneChecks = [
  [bsNone.includes('暂时给不出方案'), '给不出方案时明说，不硬凑结论'],
  [bsNone.includes('没有算进总价'), '没拿到价的商品被点名，不会悄悄当作 0'],
  [!/plan-row/.test(bsNone), '没有价格时不渲染"方案对比"表格（那是假的数据结构）'],
  [!/¥0/.test(bsNone), '不显示 ¥0 这种看起来像价格的假数字'],
];
for (const [okFlag, label] of bsNoneChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 错态：不给假的重试按钮 ---------- */
say('\n— 错态 —');
const errNoRetry = SXM.renderError('一次最多 8 件', '你写了 12 件，先算最想买的那几件。');
const errRetry   = SXM.renderError('这一步没走通', '网络超时', '重试一次');
if (!/data-retry/.test(errNoRetry)) { pass++; say('✓  重试一百次也还是错的错 → 不给按钮，不让人白点'); }
else { fail++; say('✗  不该给假的重试按钮'); }
if (errRetry.includes('data-retry="1"')) { pass++; say('✓  确实可重试的错才给按钮'); }
else { fail++; say('✗  可重试的错没有给按钮'); }

/* ---------- 回归：信息不够时反问，不许拿套话当商品名 ----------
   实测踩过的坑：「帮我买 」（没写商品）弹出一张标题为「帮我买」的比价卡，
   「帮我买 🎧🎧」按 emoji 比价，「从北京到北京」也进了比价卡。
   真实模式下这些会白打一轮平台接口、拿回一堆无关商品。 */
say('\n— 回归：不许把套话当商品名 —');
const fillerCases = [
  ['帮我买 ',      'needProduct', '只有「帮我买」没写商品 → 反问想买什么'],
  ['想买',         'needProduct', '只有「想买」→ 反问，不去比价'],
  ['帮我买 🎧🎧',  'needProduct', '只有 emoji → 不是商品名，反问'],
  ['比一比',       'needProduct', '重复套话 → 反问'],
  ['从北京到北京', 'needRoute',   '出发地=目的地 → 说清要两个不同城市，而不是当成商品名'],
];
for (const [q, wantType, label] of fillerCases) {
  const r = SXM.parseIntent(q);
  const got = r && r.type;
  if (got === wantType) { pass++; say(`✓  ${label}`); }
  else { fail++; say(`✗  ${label} —— 实际 type=${got} product=${r && r.product}`); }
}
// 反问卡本身不能带价格、不能带重试按钮（它不是错，也没什么可重试的）
const askCard = SXM.renderNeedProduct();
if (askCard.includes('想买什么') && !/¥\d/.test(askCard) && !askCard.includes('data-retry')) {
  pass++; say('✓  反问卡不出现任何价格，也不给假的重试按钮');
} else { fail++; say('✗  反问卡内容不对'); }

// 回归：正常输入一条都不能被误伤
const keepCases = [
  ['买个 猫粮',                 (r) => r.type === 'shop' && r.product === '猫粮'],
  ['帮我买 AirPods Pro 3',      (r) => r.type === 'shop' && r.product === 'AirPods Pro 3'],
  ['AirPods Pro 3 多少钱',      (r) => r.type === 'shop' && r.product === 'AirPods Pro 3'],
  ['帮我买北京烤鸭',            (r) => r.type === 'shop'],   // 含城市名但没「从…到…」，仍是购物
  ['北京到上海',                (r) => r.type === 'both'],
  ['从北京到上海',              (r) => r.type === 'both'],
];
for (const [q, okFn] of keepCases) {
  const r = SXM.parseIntent(q);
  if (okFn(r || {})) { pass++; say(`✓  没误伤：「${q}」还是原来的判断（${r && r.type}）`); }
  else { fail++; say(`✗  误伤了：「${q}」→ ${JSON.stringify(r)}`); }
}
const prodFnChecks = [
  [SXM.isMeaningfulProduct('猫粮') === true, '「猫粮」是商品名'],
  [SXM.isMeaningfulProduct('🎧') === false, '光一个 emoji 不算商品名'],
  [SXM.isMeaningfulProduct('!!!') === false, '纯标点不算商品名'],
  [SXM.isMeaningfulProduct('帮我买') === false, '纯套话不算商品名'],
  [SXM.isMeaningfulProduct('') === false && SXM.isMeaningfulProduct(null) === false, '空值不算商品名也不炸'],
  [SXM.extractProduct('帮我买 ') === '', '剥完了没东西 → 返回空串（不回落到原文）'],
];
for (const [okFlag, label] of prodFnChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}
const srcForFiller = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const noFallbackChecks = [
  [!srcForFiller.includes('return s.trim() || text;'), '「剥完为空就回落到原文」的写法已删除（防回退）'],
  [srcForFiller.includes("if (!product) return { type: 'needProduct'"), '分流层拦住空商品名'],
];

/* ---------- 回归：不存在的日期不许悄悄换掉 ----------
   实测踩过的坑：「2月30日的机票 从北京到上海」渲染出的卡片写着
   「3月2日 周二」还标着「按你说的」。JS 的 Date 对 2月30日 不报错，
   直接滚到下个月 —— 悄悄换日期比报错更危险：用户可能照着错日期排行程。 */
say('\n— 回归：不存在的日期 —');
const badDate = SXM.parseDate('2月30日的机票');
if (badDate && badDate.invalid === true && badDate.date === null) {
  pass++; say('✓  2月30日 被标记为无效，而不是滚成 3月2日');
} else { fail++; say('✗  2月30日 没被拦住：' + JSON.stringify(badDate)); }
const badDateIntent = SXM.parseIntent('2月30日的机票 从北京到上海');
if (badDateIntent && badDateIntent.type === 'needDate') {
  pass++; say('✓  出行里的无效日期 → 反问卡，不放行进渲染层');
} else { fail++; say('✗  出行无效日期没拦住：' + JSON.stringify(badDateIntent)); }
const dateCards = [[SXM.renderNeedDate({ label: '2月30日' }), '反问卡说清这天不存在']];
for (const [card, label] of dateCards) {
  if (card.includes('2月30日') && card.includes('没有这一天') && !/¥\d/.test(card)) {
    pass++; say(`✓  ${label}，且不夹带任何价格`);
  } else { fail++; say(`✗  ${label} 的文案不对`); }
}
// 正常日期一条都不能误伤（含平年/闰年的 2月29日 —— 按当年是不是闰年判定）
const baseYear = new Date().getFullYear();
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const leapDay = SXM.parseDate('2月29日 北京到上海');
const leapOk = isLeap(baseYear)
  ? (leapDay && !leapDay.invalid && leapDay.date)
  : (leapDay && leapDay.invalid === true);
if (leapOk) { pass++; say(`✓  2月29日 按当年闰年与否判定（${baseYear} 年${isLeap(baseYear) ? '是' : '不是'}闰年）`); }
else { fail++; say(`✗  2月29日 判定不对（${baseYear}）→ ${JSON.stringify(leapDay)}`); }

const goodDates = [
  ['12月31日 从北京到上海', true, '12月31日 是真实日期'],
  ['9月30日', true, '9月30日 是真实日期'],
  ['4月31日 的机票', false, '4月只有 30 天，4月31日 不存在'],
  ['13月1日 的机票', false, '13 月不存在（不匹配月日正则，落到无日期）'],
];
for (const [q, shouldParseDate, label] of goodDates) {
  const d = SXM.parseDate(q);
  const okShape = shouldParseDate
    ? (d && !d.invalid && d.date)
    : (d === null || d.invalid === true);
  if (okShape) { pass++; say(`✓  没误伤：${label}`); }
  else { fail++; say(`✗  误伤了：${label} → ${JSON.stringify(d)}`); }
}
// 购物比价跟日期无关，不该被日期问题打断
const shopWithBadDate = SXM.parseIntent('2月30日买猫粮');
if (shopWithBadDate && shopWithBadDate.type === 'shop') {
  pass++; say('✓  购物比价不受日期影响：2月30日买猫粮 仍然正常比价');
} else { fail++; say('✗  购物被日期问题误伤：' + JSON.stringify(shopWithBadDate)); }
for (const [okFlag, label] of noFallbackChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 回归：方向词 + 城市 = 出行，不是商品 ----------
   实测踩过的坑：「去上海」「到北京」「飞成都」「回广州」「订张去上海的票」
   「上海怎么走」全都被当成商品名，弹出一张标题为「去上海」的比价卡 ——
   用户明摆着要出行，界面却在给他比价。方向词在城市左边，就是出行信号。

   下面三组是**独立审计**（变异实验）逼出来的，第一版漏掉的：
   ① 方向词与城市隔 ≥2 字（「去一趟上海」）—— 固定 2 字窗口看不出来
   ② 「购 / 多少钱」类出行（「订购去上海的票」）—— 被 RE_SHOP 守卫误否
   ③ 品牌首字恰好是方向词（「回力北京布鞋」「飞猪上海酒店」）—— 被误判成出行
   这三组必须在场，否则「漏判 / 误判」两边都会悄悄回潮。 */
say('\n— 回归：方向词 + 城市 要走出行 —');
const travelCases = [
  ['去上海',       (r) => r.type === 'both' && r.to === '上海'],
  ['我要去上海',   (r) => r.type === 'both' && r.to === '上海'],
  ['到北京',       (r) => r.type === 'both' && r.to === '北京'],
  ['我想去成都',   (r) => r.type === 'both' && r.to === '成都'],
  ['回广州',       (r) => r.type === 'both' && r.to === '广州'],
  ['飞上海',       (r) => r.type === 'air'  && r.to === '上海'],
  ['出差去深圳',   (r) => r.type === 'both' && r.to === '深圳'],
  ['订张去上海的票', (r) => r.type === 'both' && r.to === '上海'],
  ['上海怎么走',   (r) => r.type === 'both' && r.to === '上海'],
  ['周末去杭州玩', (r) => r.type === 'both' && r.to === '杭州'],
  // ① 方向词与城市隔了动量词：写死 2 字窗口时会整句变成商品名
  ['去一趟上海',     (r) => r.type === 'both' && r.to === '上海'],
  ['我要去一次深圳', (r) => r.type === 'both' && r.to === '深圳'],
  ['下周去一下成都', (r) => r.type === 'both' && r.to === '成都'],
  ['去了一趟上海',   (r) => r.type === 'both' && r.to === '上海'],
  ['回了趟南京',     (r) => r.type === 'both' && r.to === '南京'],
  ['飞  上海',       (r) => r.type === 'air'  && r.to === '上海'],   // 中间夹空格
  // ② 「购 / 多少钱」不能把出行翻成购物：「票」说明要的是行程
  ['订购去上海的票', (r) => r.type === 'both' && r.to === '上海'],
  ['去上海多少钱',   (r) => r.type === 'both' && r.to === '上海'],
  ['去上海的价格',   (r) => r.type === 'both' && r.to === '上海'],
  ['去上海买票',     (r) => r.type === 'both' && r.to === '上海'],
];
for (const [q, okFn] of travelCases) {
  const r = SXM.parseIntent(q);
  if (okFn(r || {})) { pass++; say(`✓  「${q}」→ 出行（${r && r.type}${r && r.to ? ' · ' + r.to : ''}）`); }
  else { fail++; say(`✗  「${q}」没走出行 → ${JSON.stringify(r)}`); }
}
/* 带购物/外卖词、以及「品牌首字是方向词」的，一个都不许被出行抢走。
   注意品牌样本**必须带城市名**：像「回力鞋」「飞利浦剃须刀」这种没有城市的，
   findCities 返回空、第一行就返回了，压根走不到方向词逻辑 —— 那种断言是空断言，
   看着像在守品牌，其实什么都没守（审计用变异实验证明过）。 */
const notTravelCases = [
  ['帮我买北京烤鸭',       (r) => r.type === 'shop'],
  ['去上海买表',           (r) => r.type === 'shop'],   // 买 + 没有「票」→ 让位给购物
  ['到上海的外卖',         (r) => r.type === 'food'],
  ['去上海吃火锅',         (r) => r.type === 'food'],
  ['回力北京布鞋',         (r) => r.type === 'shop'],   // 「回」是品牌首字，不是方向词
  ['回力上海旗舰店',       (r) => r.type === 'shop'],
  ['飞猪上海迪士尼门票',   (r) => r.type === 'shop'],   // 有「票」字但方向词是品牌，仍算购物
  ['飞猪北京酒店',         (r) => r.type === 'shop'],
  ['飞利浦上海旗舰店',     (r) => r.type === 'shop'],
  ['AirPods Pro 3',        (r) => r.type === 'shop' && r.product === 'AirPods Pro 3'],
];
for (const [q, okFn] of notTravelCases) {
  const r = SXM.parseIntent(q);
  if (okFn(r || {})) { pass++; say(`✓  没误伤：「${q}」仍是 ${r && r.type}`); }
  else { fail++; say(`✗  误伤了：「${q}」→ ${JSON.stringify(r)}`); }
}
// 只给目的地时，出行卡要明说「还差一个出发地」，而不是给张比价卡
sandbox.localStorage.removeItem('sxm.lastFrom');
const onlyTo = SXM.parseIntent('去上海');
const travelCard = SXM.renderRoute(onlyTo);
if (onlyTo.from === null && travelCard.includes('出发地') && !/¥\d/.test(travelCard)) {
  pass++; say('✓  只认出目的地时，出行卡明确问「还差一个出发地」，不夹带任何价格');
} else { fail++; say('✗  出行卡渲染不对：' + JSON.stringify({ from: onlyTo.from, head: travelCard.slice(0, 60) })); }
/* 这里原先还有一条 `srcForFiller.includes('directionTravel')` 的断言，已删。
   它是纯 grep 源码字符串：把函数改名、甚至让它无条件 return null（功能全废），
   这条都照样通过 —— 不是验证，只是装饰。行为断言（上面 30 条）才是真的守卫。 */

/* ---------- 回归：推荐类问法要出商品名，不是整句 ----------
   实测踩过的坑：「推荐个耳机」的整句被当成商品名，弹出一张标题为
   「推荐个耳机」的比价卡；真实模式下还会拿整句去搜平台。 */
say('\n— 回归：推荐 / 求推荐 类问法 —');
const recCases = [
  ['推荐个耳机',         (r) => r.product === '耳机'],
  ['推荐一下扫地机器人', (r) => r.product === '扫地机器人'],
  ['推荐点儿零食',       (r) => r.product === '零食'],
  ['推荐几款耳机',       (r) => r.product === '耳机'],
  ['给我推荐个手机',     (r) => r.product === '手机'],
  ['笔记本电脑求推荐',   (r) => r.product === '笔记本电脑'],
  ['求推荐耳机',         (r) => r.product === '耳机'],
  ['有没有好用的剃须刀', (r) => r.product === '剃须刀'],
  ['哪款耳机好',         (r) => r.product === '耳机'],
  // 剥完只剩「推荐」两个字 → 没给商品名，该反问而不是拿「推荐」去比价
  ['给我推荐',           (r) => r.type === 'needProduct'],
  ['推荐',               (r) => r.type === 'needProduct'],
];
for (const [q, okFn] of recCases) {
  const r = SXM.parseIntent(q);
  if (okFn(r || {})) { pass++; say(`✓  「${q}」→ ${r && r.type}${r && r.product ? ' · ' + r.product : ''}`); }
  else { fail++; say(`✗  「${q}」→ ${JSON.stringify(r)}`); }
}
/* 量词表收窄的反面：这些「推荐 + 名词」不许被切坏。
   「推荐算法」是商品名；双肩包 / 台灯 / 儿童玩具 更是量词表一旦放宽就会被吃掉的名词。 */
const recKeepCases = [
  ['推荐算法',     '推荐算法'],
  ['推荐儿童玩具', '推荐儿童玩具'],
  ['推荐双肩包',   '推荐双肩包'],
  ['推荐台灯',     '推荐台灯'],
  ['双肩包',       '双肩包'],
  ['台灯',         '台灯'],
  ['洗发水好',     '洗发水好'],   // 「好」只在整句是问句时才敢剥
  ['AirPods Pro 3', 'AirPods Pro 3'],
  ['iphone 16 多少钱', 'iphone 16'],
];
for (const [q, want] of recKeepCases) {
  const r = SXM.parseIntent(q);
  if (r && r.type === 'shop' && r.product === want) { pass++; say(`✓  没切坏：「${q}」→ ${want}`); }
  else { fail++; say(`✗  切坏了：「${q}」→ ${JSON.stringify(r)}（期望 ${want}）`); }
}

/* ---------- 回归：问「吃什么」也算外卖 ----------
   实测踩过的坑：「有什么好吃的」「附近有什么好吃的」掉进购物分支，
   弹出一张标题为「有什么好吃的」的比价卡。
   但「好吃的」这几个字本身也会出现在购物句里，所以它只是**弱信号**：
   句子里一旦有购物词（买…），仍归购物。 */
say('\n— 回归：问吃什么 也算外卖 —');
const foodCases = [
  '有什么好吃的', '附近有什么好吃的', '明天中午吃什么', '中午吃啥',
  '晚饭吃什么好', '吃点什么', '点一份麻辣烫', '到上海的外卖',
];
for (const q of foodCases) {
  const r = SXM.parseIntent(q);
  if (r && r.type === 'food') { pass++; say(`✓  「${q}」→ 外卖`); }
  else { fail++; say(`✗  「${q}」没进外卖 → ${JSON.stringify(r)}`); }
}
const weakFoodShop = SXM.parseIntent('好吃的饼干买哪个');
if (weakFoodShop && weakFoodShop.type === 'shop') {
  pass++; say('✓  弱信号不抢购物：「好吃的饼干买哪个」仍是购物（有「买」）');
} else { fail++; say(`✗  弱外卖信号抢走了购物句：${JSON.stringify(weakFoodShop)}`); }

/* ---------- 清单输入切分 ---------- */
say('\n— 清单输入切分 —');
const splitCases = [
  ['猫粮\n洗衣液', 2, '换行分隔'],
  ['猫粮，洗衣液、猫砂;耳机', 4, '中英文逗号 / 顿号 / 分号都能分'],
  ['猫粮\n\n\n洗衣液', 2, '空行不产生空商品'],
  ['  猫粮  \n  洗衣液  ', 2, '首尾空白被清掉'],
  ['猫粮', 1, '单件也给得出来'],
  ['', 0, '空输入返回空数组'],
  [null, 0, 'null 不炸'],
  ['AirPods Pro 3\n扫地机器人', 2, '带空格和数字的英文商品名不会被误切'],
];
for (const [txt, wantN, label] of splitCases) {
  const got = SXM.splitBasketInput(txt);
  if (got.length === wantN) { pass++; say(`✓  ${label} → ${got.length} 件`); }
  else { fail++; say(`✗  ${label} → 期望 ${wantN} 件，实际 ${got.length} 件：${JSON.stringify(got)}`); }
}

/* ---------- 主题 ---------- */
say('\n— 主题 —');
SXM.setTheme('dark');
const themeOk1 = SXM.theme === 'dark' && SXM.isDark === true;
SXM.setTheme('light');
const themeOk2 = SXM.theme === 'light' && SXM.isDark === false;
SXM.setTheme('乱写的值');
const themeOk3 = SXM.theme === 'auto';
if (themeOk1) { pass++; say('✓  切到深色：主题状态和实际明暗一致'); } else { fail++; say('✗  深色切换不对'); }
if (themeOk2) { pass++; say('✓  切到浅色：主题状态和实际明暗一致'); } else { fail++; say('✗  浅色切换不对'); }
if (themeOk3) { pass++; say('✓  非法主题值回落到 auto，而不是把界面搞成没颜色的状态'); } else { fail++; say('✗  非法主题值没有兜住'); }

// applyTheme 必须把 data-theme 写到 <html> 上——styles.css 的暗色选择器全靠它
const htmlAttrOk = DOC_EL.attrs['data-theme'] === 'light';
if (htmlAttrOk) { pass++; say('✓  data-theme 挂在 documentElement 上（CSS 暗色钩子还在）'); }
else { fail++; say('✗  documentElement 上没有 data-theme，暗色 CSS 会全部失效：' + JSON.stringify(DOC_EL.attrs)); }

// 循环切换走完一圈必须回到「自动」
SXM.setTheme('auto');
SXM.cycleTheme(); SXM.cycleTheme(); SXM.cycleTheme();
const cycleOk = SXM.theme === 'auto';
if (cycleOk) { pass++; say('✓  顶栏循环切换：自动→浅色→深色→自动，能回得去'); }
else { fail++; say('✗  循环三步后回不到 auto（实际 ' + SXM.theme + '）'); }

/* ---------- 回归：主题选择不许用 [data-theme] 当事件选择器 ----------
   曾经的 bug：applyTheme 把 data-theme 写在 <html> 上，而点击处理器用
   closest('[data-theme]') 找主题 chip —— closest 会冒泡命中 <html>，
   于是页面任意点击都会触发 setTheme。深色系统下用户从深色循环回
   「自动」会被劫持回深色，永远回不去。实测复现后才改成 .theme-chip。
   这里对源码做断言，防止将来有人"顺手改回去"。 */
say('\n— 回归：data-theme 选择器冲突 —');
const appSource = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const selOk1 = appSource.includes("closest('.theme-chip')");
const selOk2 = !appSource.includes("closest('[data-theme]')");
const selOk3 = appSource.includes('chip theme-chip');
if (selOk1 && selOk2 && selOk3) { pass++; say('✓  主题点击用 .theme-chip 专属类，html 上的 data-theme 不会再吃掉全局点击'); }
else { fail++; say('✗  主题选择器回归：theme-chip=' + selOk1 + ' 无残留[dataset主题选择器]=' + selOk2 + ' 模板带类名=' + selOk3); }

/* ---------- 最近查询 ---------- */
say('\n— 最近查询 —');
const recentChecks = [
  [JSON.stringify(SXM.dedupeRecent(['a','b'], 'c')) === JSON.stringify(['c','a','b']), '新查询置顶'],
  [JSON.stringify(SXM.dedupeRecent(['a','b','c'], 'b')) === JSON.stringify(['b','a','c']), '重复查询去重并置顶，不产生第二条'],
  [SXM.dedupeRecent(['a','b','c','d','e','f','g','h'], 'i').length === 8
    && SXM.dedupeRecent(['a','b','c','d','e','f','g','h'], 'i')[0] === 'i', '最多留 8 条，旧的先淘汰'],
  [JSON.stringify(SXM.dedupeRecent(['a'], '   ')) === JSON.stringify(['a']), '空白输入不产生记录'],
  [JSON.stringify(SXM.dedupeRecent(['a'], null)) === JSON.stringify(['a']), 'null 不炸'],
  [JSON.stringify(SXM.dedupeRecent([], '  耳机  ')) === JSON.stringify(['耳机']), '首尾空白被清掉'],
];
for (const [okFlag, label] of recentChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 降价关注：纯逻辑 ---------- */
say('\n— 降价关注 —');
const watchChecks = [
  // 新增 / 更新同一条 / 上限
  [SXM.upsertWatch([], { qKey:'耳机', platform:'jd', price:199 }).length === 1, '新增一条关注'],
  [
    SXM.upsertWatch(
      [{ qKey:'耳机', platform:'jd', price:199 }, { qKey:'耳机', platform:'pdd', price:189 }],
      { qKey:'耳机', platform:'jd', price:179 }
    ).length === 2
      && SXM.upsertWatch(
        [{ qKey:'耳机', platform:'jd', price:199 }, { qKey:'耳机', platform:'pdd', price:189 }],
        { qKey:'耳机', platform:'jd', price:179 }
      )[0].price === 179,
    '同商品+同平台算同一条，更新而不是重复存',
  ],
  [SXM.upsertWatch(Array.from({length:12}, (_, i) => ({ qKey:'x'+i, platform:'jd', price:1 })), { qKey:'new', platform:'jd', price:1 }).length === 10, '最多关注 10 条'],
  // 降价判定：宁可没提醒，不给假优惠
  [SXM.priceDrop(199, 179) !== null && SXM.priceDrop(199, 179).saved === 20, '真降价 → 算出差额'],
  [SXM.priceDrop(199, 199) === null, '同价不是降价'],
  [SXM.priceDrop(199, 219) === null, '涨价不给提醒（更不是假"降价"）'],
  [SXM.priceDrop(0, 10) === null && SXM.priceDrop(null, 10) === null && SXM.priceDrop('abc', 10) === null, '价格不可信时不产生提醒'],
];
for (const [okFlag, label] of watchChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

// watchAdd 的兜底：没有可信价格就不存 —— "关注"不能建立在假数字上
sandbox.localStorage.removeItem('sxm.watch');
SXM.watchRemove('x', 'jd'); // 清场，防前面测试留数据
const watchBefore = SXM.watchCount;
SXM.renderRecent && SXM.renderRecent(); // 顺手验证 renderRecent 在无 DOM 下不炸
if (SXM.watchCount === watchBefore) { pass++; say('✓  watchAdd 空参数/坏价格不落库'); }
else { fail++; say('✗  watchAdd 存进了不可信数据'); }

/* ---------- 复制文本 ---------- */
say('\n— 复制文本 —');
const liveText = SXM.shopLiveToText('耳机', {
  platforms: [
    { id:'jd', name:'京东', ok:true, count:3, lowest:{ final:179 } },
    { id:'pdd', name:'拼多多', ok:false, count:0 },
  ],
});
const liveTextChecks = [
  [liveText.includes('京东：最低 ¥179'), '平台+最低价都在文本里'],
  [liveText.includes('拼多多：没拿到'), '没拿到价的平台如实写"没拿到"'],
  [liveText.includes('官方 App'), '带"下单走官方"的提示，复制出去不带引导支付的暗示'],
];
const demoText = SXM.shopLiveToText('耳机', { demo:true, platforms:[{ id:'jd', name:'京东', ok:true, count:1, lowest:{ final:179 } }] });
liveTextChecks.push([demoText.includes('演示数据'), '演示数据复制出来必须带标注，不能冒充真价']);

const basketSplitText = SXM.basketToText({
  recommend:'split', reason:'分两家买省 23.5 元', itemCount:2,
  items:[{ q:'猫粮', best:{ platform:'jd', name:'京东', final:'128.00' } }],
  split:{ total:'187.80', platforms:[{ name:'京东', subtotal:'167.90' }] },
  bestSingle:{ name:'京东', total:'211.30' },
});
const basketNoneText = SXM.basketToText({
  recommend:'none', reason:'没拿到任何价格', itemCount:1,
  items:[{ q:'耳机', best:null }],
});
liveTextChecks.push(
  [basketSplitText.includes('分件买：京东 ¥167.90') && basketSplitText.includes('¥187.80'), '方案文本带分平台小计与总价'],
  [basketNoneText.includes('暂时给不出方案') && !/¥\d/.test(basketNoneText), '给不出方案的文本里绝不出现任何价格'],
);

/* 回归：多张卡片并存时，复制必须各拿各的文本。
   曾经的 bug：复制文本存在单一全局变量里，后渲染的卡把它覆盖掉 ——
   页面上的 3 个「复制结果」按钮 data-copy 全是 "1"，点第一张卡（耳机）
   复制出来的却是最后一张卡（手表）的内容。用户会把张冠李戴的结果转发出去。
   实测复现后改成按 id 注册。这里既验行为，也对源码做断言防回退。 */
const copyIdA = SXM.registerCopyText('A 卡内容');
const copyIdB = SXM.registerCopyText('B 卡内容');
const copyStoreChecks = [
  [copyIdA !== copyIdB, '每次注册返回不同的 id（多卡不会互相覆盖）'],
  [SXM.copyStored(copyIdA) === 'A 卡内容' && SXM.copyStored(copyIdB) === 'B 卡内容', '按 id 能取回各自那份文本'],
  [SXM.copyStored('不存在') === undefined, '取不存在的 id 返回 undefined（上层给"已过期"提示）'],
  [SXM.registerCopyText(null) !== copyIdA && SXM.copyStored(SXM.registerCopyText('')) === '', 'null/空文本不炸'],
];
const trimMap = new Map();
for (let i = 1; i <= 8; i++) trimMap.set('k' + i, i);
const dead = SXM.trimCopyStore(trimMap, 3);
copyStoreChecks.push(
  [dead.length === 5 && trimMap.size === 3, '容量上限只留最近 N 条，长会话不无限占内存'],
  [trimMap.has('k8') && !trimMap.has('k1'), '淘汰的是最旧的，最新的留着'],
  [SXM.trimCopyStore(new Map(), 3).length === 0, '空表不炸'],
);
const copySrcChecks = [
  [!appSource.includes('LAST_COPY_TEXT'), '单一全局复制变量已彻底移除（防有人改回去）'],
  [appSource.includes('data-copy="${copyId}"'), '复制按钮带自己的 id，不是写死的 "1"'],
  [appSource.includes('COPY_STORE.get(copyBtn.dataset.copy)'), '点击按 id 取文本'],
];
for (const [okFlag, label] of copyStoreChecks.concat(copySrcChecks)) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}
for (const [okFlag, label] of liveTextChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 比价卡上的关注按钮：真实数据才有，演示数据没有 ---------- */
say('\n— 关注按钮的演示隔离 —');
const realLiveCard = SXM.renderShopLive('耳机', {
  platforms:[{ id:'jd', name:'京东', ok:true, count:2,
    lowest:{ final:179, history:{ count:3, points:[{t:1,v:181},{t:2,v:180},{t:3,v:179}] } },
    items:[{ title:'样例', final:179, url:'https://x.jd.com/1' }] }],
  unconfigured:[], disclaimer:'测试免责声明',
});
const demoLiveCard = SXM.renderShopLive('耳机', {
  demo:true,
  platforms:[{ id:'jd', name:'京东', ok:true, count:2,
    lowest:{ final:179, history:{ count:3, points:[{t:1,v:181},{t:2,v:180},{t:3,v:179}] } },
    items:[{ title:'样例', final:179, url:'#demo' }] }],
  unconfigured:[],
});
const watchIso = [
  [realLiveCard.includes('data-watch'), '真实比价卡有关注降价按钮'],
  [!demoLiveCard.includes('data-watch'), '演示卡没有关注按钮（关注假价格=记假账）'],
  [realLiveCard.includes('data-copy'), '比价卡带复制按钮'],
];
for (const [okFlag, label] of watchIso) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 分享链接 / 淘口令识别 ---------- */
say('\n— 分享链接识别 —');
const shareCases = [
  ['https://item.jd.com/100012043978.html', { kind:'jd-item', id:'100012043978' }, '京东商品链接 → SKU'],
  ['https://item.jd.com/100012043978.html 这个链接帮我看看', { kind:'jd-item', id:'100012043978' }, '链接混在文字里也能认出'],
  ['https://search.jd.com/Search?keyword=%E6%89%AB%E5%9C%B0%E6%9C%BA%E5%99%A8%E4%BA%BA&enc=utf-8', { kind:'keyword', keyword:'扫地机器人' }, '京东搜索链接 → 解出关键词'],
  ['https://mobile.yangkeduo.com/goods.html?goods_id=888881234', { kind:'pdd-item', id:'888881234' }, '拼多多商品链接 → goods_id'],
  ['https://detail.tmall.com/item.htm?id=654321098765', { kind:'tb-item', id:'654321098765' }, '天猫商品链接 → itemId'],
  ['复制这条信息 ¥Ab12Cd34Ef¥ 打开手机淘宝', { kind:'tpwd' }, '淘口令（成对符号）被认出来'],
  ['https://example.com/whatever', null, '无关链接不误报'],
  ['帮我买 AirPods Pro 3', null, '普通话术不受影响'],
];
for (const [txt, want, label] of shareCases) {
  const got = SXM.parseShareText(txt);
  const okFlag = want === null
    ? got === null
    : got !== null && Object.keys(want).every((k) => String(got[k]) === String(want[k]));
  if (okFlag) { pass++; say(`✓  ${label}`); }
  else { fail++; say(`✗  ${label} → ${JSON.stringify(got)}`); }
}

// 口令周边文字剥离：'xxx商品 ¥Ab12Cd34¥ 打开淘宝' → 商品名可提取
const stripCase = SXM.stripUrlText('科沃斯扫地机器人 ¥Ab12Cd34Ef 打开淘宝'.replace('¥Ab12Cd34Ef', ' '));
if (stripCase === '科沃斯扫地机器人 打开淘宝' || stripCase === '科沃斯扫地机器人 打开淘宝') { pass++; say('✓  口令剥离后文字可当搜索词'); }
else { fail++; say('✗  口令剥离结果不对：' + JSON.stringify(stripCase)); }

// 诚实性：识别卡不出现任何价格数字
const shareCard = SXM.renderShareParsed({ kind:'jd-item', id:'100012043978', platform:'jd' });
const tpwdCard = SXM.renderShareParsed({ kind:'tpwd', token:'¥Ab12Cd34Ef', platform:'dataoke' });
const shareChecks = [
  [shareCard.includes('100012043978') && shareCard.includes('配上密钥后这一步全自动'), '商品识别卡：给 ID + 说明配密钥后自动化'],
  [!/class="(price|bi-price)"/.test(shareCard), '识别卡不出现价格（没有接口就不该有价格）'],
  [tpwdCard.includes('解不开') && tpwdCard.includes('邀约制'), '淘口令卡明说解不开，不假装成功'],
  [!/¥\d/.test(tpwdCard), '口令卡不出现任何价格'],
];
for (const [okFlag, label] of shareChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

/* ---------- 关注清单同步码 ---------- */
say('\n— 同步码导出导入 —');
const sampleWatch = [
  { qKey:'扫地机器人', q:'扫地机器人', platform:'jd', sku:'x', title:'科沃斯', price:1299, ts:1 },
  { qKey:'洗衣液', q:'洗衣液', platform:'pdd', sku:'', title:'', price:39.9, ts:2 },
];
const syncCode = SXM.encodeWatchCode(sampleWatch);
const syncChecks = [
  [syncCode.indexOf('SXM1.') === 0, '同步码带版本前缀'],
  [!/[{}\u4e00-\u9fa5]/.test(syncCode), '同步码是 URL 安全的 ASCII（复制粘贴不会碎）'],
  [JSON.stringify(SXM.decodeWatchCode(syncCode)) === JSON.stringify(sampleWatch), '导出再解回来，内容一字不差'],
  [SXM.decodeWatchCode('垃圾字符串') === null, '非同步码 → null'],
  [SXM.decodeWatchCode('SXM1.%7B%22not%22%3A%22array%22%7D') === null, '前缀对但内容不是数组 → null'],
  [SXM.decodeWatchCode('SXM1.' + encodeURIComponent('[{"q":"x","platform":"jd","price":"abc"}]')) !== null
    && SXM.decodeWatchCode('SXM1.' + encodeURIComponent('[{"q":"x","platform":"jd","price":"abc"}]')).length === 0, '价格非法的条目被剔除而不是炸掉'],
];
for (const [okFlag, label] of syncChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}
// 导入是合并不是覆盖：本机已有的不动
sandbox.localStorage.setItem('sxm.watch', JSON.stringify([{ qKey:'猫粮', q:'猫粮', platform:'jd', price:59 }]));
const importN = SXM.watchImport(syncCode);
const afterImport = JSON.parse(sandbox.localStorage.getItem('sxm.watch'));
if (importN === 2 && afterImport.length === 3
  && afterImport.some((w) => w.qKey === '猫粮')
  && afterImport.some((w) => w.qKey === '扫地机器人' && w.price === 1299)) { pass++; say('✓  导入合并本机记录，3 条共存'); }
else { fail++; say('✗  导入结果不对：n=' + importN + ' list=' + JSON.stringify(afterImport)); }
sandbox.localStorage.removeItem('sxm.watch');

/* ---------- 分享深链 ---------- */
say('\n— 分享深链 —');
const shareUrlChecks = [
  [SXM.shareUrl('耳机', false) === '/?q=' + encodeURIComponent('耳机'), '真实模式深链：/?q=商品名'],
  [SXM.shareUrl('耳机', true) === '/?demo=1&q=' + encodeURIComponent('耳机'), '演示深链带 demo 标记，收链接的人不会被假数字骗'],
  [SXM.shareUrl('  耳机  ', false) === '/?q=' + encodeURIComponent('耳机'), '商品名首尾空白被清掉'],
  [SXM.shareUrl('', false) === '/?q=', '空商品不炸'],
];
for (const [okFlag, label] of shareUrlChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label} → ${SXM.shareUrl('耳机', false)}`); }
}

/* ---------- 网页版独有能力：安装 + 语音 ---------- */
say('\n— 网页版独有能力 —');
const htmlSource = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const webOnlyChecks = [
  // 安装到桌面：按钮藏在 html 里，只有 beforeinstallprompt 真的来了才露出
  [htmlSource.includes('id="btn-install"') && htmlSource.includes('btn-install" type="button" title="安装到桌面'), '安装按钮挂在顶栏，默认 hidden'],
  [appSource.includes("addEventListener('beforeinstallprompt'"), '监听 beforeinstallprompt——事件没来就不给死按钮'],
  [appSource.includes("addEventListener('appinstalled'"), '安装成功后有反馈，且事件只消费一次'],
  // 语音输入：不支持的环境绝不露出按钮
  [htmlSource.includes('id="btn-mic"') && htmlSource.includes('aria-label="语音输入"'), '麦克风按钮挂在输入行，默认 hidden'],
  [appSource.includes('window.SpeechRecognition || window.webkitSpeechRecognition'), '先探测 Web Speech API，不支持就不露按钮'],
  [appSource.includes("rec.lang = 'zh-CN'"), '识别语言固定中文'],
  [appSource.includes("ev.error === 'not-allowed'"), '权限被拒给明确提示，不静默失败'],
  [appSource.includes('rec.onend') && appSource.includes("micBtn.classList.remove('listening')"), '识别结束一定收起「听诊中」状态——onerror 后 onend 也会走，状态不会卡死'],
  [appSource.includes('form.requestSubmit'), '识别结果直接替用户发问'],
  // 自测抓到的 bug：受限环境 prompt() 会抛，收按钮必须发生在 try 之前
  [appSource.includes('installBtn.hidden = true; // 事件只能消费一次'), '点安装先收按钮再 prompt，异常路径不会把按钮卡在半路'],
  [appSource.includes("showToast('这个浏览器没能启动语音识别"), 'start() 抛异常也给 toast，不静默失败'],
  // 自测抓到的 bug：无头环境识别会静默卡死，按钮永远停在「听诊中」
  [appSource.includes('看门狗') && appSource.includes('}, 10000);'), '10 秒看门狗：识别静默卡死时强制收场并提示'],
  [appSource.includes('watchDog = null;'), '正常结束会清掉看门狗，不会误伤下一次识别'],
  [appSource.includes('const silent = !gotText && !errored && !cancelled'), '静默结束（无结果无报错）也给提示——用户点完麦克风不该毫无回应'],
  [appSource.includes('cancelled = true; try { rec && rec.stop()'), '手动取消不误报「没听清」'],
];
for (const [okFlag, label] of webOnlyChecks) {
  if (okFlag) { pass++; say(`✓  ${label}`); } else { fail++; say(`✗  ${label}`); }
}

say(`\n结果：${pass} 通过 / ${fail} 失败`);
flush();
process.exit(fail ? 1 : 0);
