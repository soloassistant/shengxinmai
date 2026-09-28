/* ==========================================================================
   省心买 · 「上线水准」验证 harness
   --------------------------------------------------------------------------
   它验的是这一轮新增的工程能力，和 test-server.js 的分工是：
     test-server.js  —— 平台对接对不对（签名、单位、解析、聚合隔离）
     test-quality.js —— 上线之后才痛的东西对不对：
                        · 省钱清单给的建议是不是真的成立（穷举各种组合）
                        · 价格历史会不会编数据、样本不够会不会硬给结论
                        · 缓存/限流/重试/指标是否真的起作用（而不是写了没接上）
                        · 静态服务会不会把 .data 价格历史库暴露出去

   运行：node server/test-quality.js
   ========================================================================== */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG = [];
const say = (s) => { LOG.push(s); console.log(s); };
let pass = 0, fail = 0;
const ok  = (m) => { pass++; say('✓  ' + m); };
const bad = (m) => { fail++; say('✗  ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const { createCache, normKey }    = require('./lib/cache');
const { createRateLimiter }       = require('./lib/ratelimit');
const { createMetrics }           = require('./lib/metrics');
const { createStore, titleFingerprint, MIN_SAMPLES } = require('./lib/store');
const { computeBasket }           = require('./lib/basket');
const { withRetry, isRetriable }  = require('./lib/http');

/* ==========================================================================
   1. TTL 缓存
   ========================================================================== */
say('— TTL 缓存 —');

const c = createCache({ ttl: 100, max: 3 });
c.set('a', 1, 1000);
check(c.get('a', 1050) === 1, '未过期时命中缓存');
check(c.get('a', 1100) === null, '到 TTL 边界即失效（exp <= now 算过期）');
check(c.stats().hits === 1 && c.stats().misses === 1,
  '命中/未命中计数正确：' + c.stats().hits + ' / ' + c.stats().misses);

c.clear();
c.set('k1', 'v1', 1000); c.set('k2', 'v2', 1000); c.set('k3', 'v3', 1000);
c.get('k1', 1010);                                   // k1 变成"最近使用"
c.set('k4', 'v4', 1020);                             // 满了，应淘汰最久没用的 k2
check(c.get('k2', 1021) === null, 'LRU 淘汰的是最久未用的那条（k2），不是随便一条');
check(c.get('k1', 1021) === 'v1', '刚被访问过的 k1 留下来了');

check(normKey('  AirPods   Pro ') === 'airpods pro',
  '缓存键归一化：大小写/首尾/连续空格不再各占一份缓存');
check(normKey(null) === '', 'null 归一化成空串，而不是字符串 "null"');

// 命中率要能被证明，否则"加了缓存"是自说自话
check(typeof c.stats().hitRate === 'number', '/api/metrics 能拿到命中率：' + c.stats().hitRate);

/* ==========================================================================
   2. 令牌桶限流
   ========================================================================== */
say('\n— 令牌桶限流 —');

let clock = 0;
const rl = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => clock });
check(rl.take('ip1').allowed, '桶容量 3：第 1 次放行');
check(rl.take('ip1').allowed, '第 2 次放行');
check(rl.take('ip1').allowed, '第 3 次放行');
const blocked = rl.take('ip1');
check(!blocked.allowed, '第 4 次被拦下');
check(blocked.retryAfter >= 1, '被拦时给出明确等待秒数，而不是只说"太频繁"：' + blocked.retryAfter + 's');
check(rl.take('ip2').allowed, '不同 IP 各自独立计数，一个人刷不垮所有人');

clock = 1000;
check(rl.take('ip1').allowed, '过 1 秒补回 1 个令牌，自动恢复放行');

const rlCap = createRateLimiter({ capacity: 1, maxKeys: 2, now: () => 0 });
rlCap.take('a'); rlCap.take('b'); rlCap.take('c');
check(rlCap.size <= 2, '桶数量有硬上限，不会被随机源 IP 刷爆内存（当前 ' + rlCap.size + ' 个）');

/* ==========================================================================
   3. 价格历史 —— 重点是"绝不编数据"
   ========================================================================== */
say('\n— 价格历史 —');

const TMP = path.join(os.tmpdir(), 'sxm-test-' + process.pid + '-' + Date.now() + '.jsonl');
const st = createStore({ file: TMP });

check(st.recordOne({ platform: 'jd', sku: '1001', title: '测试', final: 100, at: 1 }) === true,
  '记录第一个价格点');
check(st.recordOne({ platform: 'jd', sku: '1001', title: '测试', final: 100, at: 1 }) === false,
  '同一时间戳同一价格不重复记点（重试/重放会走到这里）');
st.recordOne({ platform: 'jd', sku: '1001', title: '测试', final: 90, at: 2 });
st.recordOne({ platform: 'jd', sku: '1001', title: '测试', final: 95, at: 3 });

const h1 = st.history('jd', '1001');
check(h1.found === true && h1.count === 3, '历史点数 = 3，实际 ' + h1.count);
check(h1.lowest === 90 && h1.highest === 100,
  '历史最低/最高算对：' + h1.lowest + ' / ' + h1.highest);
check(h1.verdict === 'mid', '当前价 95 落在区间中部 → mid，实际 ' + h1.verdict);
check(/差/.test(h1.verdictText), '结论里带上了离最低价还差多少：' + h1.verdictText);
check(h1.note.includes('我们自己采集'),
  '历史响应始终带着「只含自采数据」的说明 —— 这条不能只在文档里');

// 存盘后换个实例读回来（模拟重启）
const stReopen = createStore({ file: TMP });
check(stReopen.history('jd', '1001').count === 3, '重启后能从 JSONL 文件把历史读回来');

// 样本不足必须说不知道
const stFew = createStore({});
stFew.recordOne({ platform: 'jd', sku: 'x', title: 'a', final: 10, at: 1 });
stFew.recordOne({ platform: 'jd', sku: 'x', title: 'a', final: 9, at: 2 });
const hFew = stFew.history('jd', 'x');
check(hFew.verdict === 'insufficient',
  '只采到 2 次（< ' + MIN_SAMPLES + '）时不给结论，实际 ' + hFew.verdict);
check(/至少/.test(hFew.verdictText), '并且说清还差多少才给结论：' + hFew.verdictText);

const hNone = stFew.history('jd', 'never-seen');
check(hNone.found === false && hNone.verdict === 'unknown',
  '从没采到过的商品返回 found:false，而不是编一段历史出来');
check(hNone.points.length === 0, '没数据时曲线点也是空的，前端不会画出假曲线');

stFew.recordOne({ platform: 'jd', sku: 'y', title: 'b', final: 30, at: 1 });
stFew.recordOne({ platform: 'jd', sku: 'y', title: 'b', final: 30, at: 2 });
stFew.recordOne({ platform: 'jd', sku: 'y', title: 'b', final: 20, at: 3 });
check(stFew.history('jd', 'y').verdict === 'lowest', '跌到新低时判定为「采集以来的最低价」');

// 边界
check(stFew.history('jd', 'y').points.every((p) => Number.isFinite(p.f)),
  '历史点里的价格都是有效数字，不会混进 NaN/null');
check(st.recordOne({ platform: 'jd', sku: '', title: '', final: 10, at: 9 }) === false,
  '既没有商品 ID 也没有标题时不记录 —— 宁可少一条，也不塞一个假身份');
check(st.recordOne({ platform: 'jd', sku: 'z', title: 'z', final: 0, at: 9 }) === false,
  '价格为 0 不记录（0 元不是价格，是解析出错的信号）');

const stCap = createStore({ maxPointsPerSku: 3 });
for (let i = 0; i < 5; i++) stCap.recordOne({ platform: 'jd', sku: 'z', title: 'c', final: 10 + i, at: i });
check(stCap.history('jd', 'z').count === 3, '每个商品点数有上限，超出丢最旧的（当前 ' + stCap.history('jd', 'z').count + ' 条）');

check(titleFingerprint('【限时秒杀】测试商品 500ml') === titleFingerprint('测试商品 500ml'),
  '标题指纹忽略【】促销前缀，同一件东西不会因换活动文案被拆成两段历史');
check(titleFingerprint('') === '', '空标题返回空指纹，不产生假身份');

try { fs.unlinkSync(TMP); } catch { /* 临时文件清理失败无所谓 */ }

/* ==========================================================================
   4. 省钱清单算法 —— 这一轮最核心的产品逻辑，穷举各种组合
   ========================================================================== */
say('\n— 省钱清单算法 —');

const NAMES = { jd: '京东', pdd: '拼多多', dataoke: '淘宝' };
const B = (q, pairs) => ({
  q,
  byPlatform: Object.fromEntries(pairs),
  names: NAMES
});

/* --- 差额够大：应该建议分件买 --- */
const r1 = computeBasket([
  B('猫粮', [['jd', 70], ['pdd', 100]]),
  B('猫砂', [['jd', 100], ['pdd', 30]])
]);
check(r1.split.total === 100, '分件最优总价 = 70 + 30 = 100，实际 ' + r1.split.total);
check(r1.split.platformCount === 2, '两件商品的最低价分属两家，要开 2 个 App');
check(r1.bestSingle.total === 130, '一家买齐最便宜是拼多多 130，实际 ' + r1.bestSingle.total);
check(r1.savingVsBestSingle === 30, '差额 = 130 − 100 = 30，实际 ' + r1.savingVsBestSingle);
check(r1.recommend === 'split', '差额 30 超过麻烦门槛 10 → 建议分件买，实际 ' + r1.recommend);
check(r1.reason.includes('30.00'), '给用户的理由里带上了具体金额：' + r1.reason);
check(r1.items[0].best.name === '京东', '最优项带上了中文平台名，前端不用再查表');

/* --- 差额为 0：应该建议图省事，且文案不能是"少开 0 个 App" --- */
const r2 = computeBasket([
  B('牙膏', [['jd', 20], ['pdd', 22]]),
  B('牙刷', [['jd', 30], ['pdd', 30]])
]);
check(r2.appsSaved === 0, '所有商品最低价都在同一家 → appsSaved = 0，实际 ' + r2.appsSaved);
check(r2.recommend === 'single', '不需要多开 App 时直接建议一家买齐，实际 ' + r2.recommend);
check(!/少开 0 个/.test(r2.reason), '文案里不会出现"少开 0 个 App"这种自相矛盾的话：' + r2.reason);

/* --- 麻烦门槛确实可调 --- */
const r3 = computeBasket([
  B('A', [['jd', 100], ['pdd', 70]]),
  B('B', [['jd', 30], ['pdd', 60]])
], { saveThreshold: 100 });
check(r3.savingVsBestSingle === 30, '同样的单子差额还是 30，实际 ' + r3.savingVsBestSingle);
check(r3.recommend === 'single', '把门槛调到 100 后，同样的 30 元就建议图省事 —— 阈值是产品决策，确实可调');
check(r3.threshold === 100, '返回值带上当时用的阈值，前端才能解释这个结论怎么来的');

/* --- 买不齐的平台不算"一家买齐" --- */
const r4 = computeBasket([
  B('X', [['jd', 10], ['pdd', 12]]),
  B('Y', [['jd', 20]])                   // 拼多多没搜到 Y
]);
check(r4.singles.length === 1, '覆盖不全整单的平台被排除在"一家买齐"之外（残次品不是方案）');
check(r4.bestSingle.platform === 'jd', '只剩京东可选，实际 ' + r4.bestSingle.platform);

/* --- 有商品完全没价：必须说出来，不能当 0 算 --- */
const r5 = computeBasket([
  B('有价', [['jd', 50]]),
  B('没价', [])
]);
check(r5.unpriced.length === 1 && r5.unpriced[0].q === '没价', '没拿到价的商品被单独列出来');
check(r5.split.total === 50, '总价只算拿到价的商品，不把没价的当 0 混进去（实际 ' + r5.split.total + '）');
check(/没拿到价格/.test(r5.reason), '理由里明说有几件没价、总价不能当整单看：' + r5.reason);

/* --- 一件都没价 --- */
const r6 = computeBasket([B('a', []), B('b', [])]);
check(r6.recommend === 'none' && r6.split.total === 0,
  '一件都拿不到价时给 recommend:none，而不是硬凑一个方案');

/* --- 单件 --- */
const r7 = computeBasket([B('单件', [['jd', 80], ['pdd', 90]])]);
check(r7.recommend === 'single' && /只有一件/.test(r7.reason),
  '只有一件商品时直接说去哪买，不硬套两方案对比');

/* --- 价差与次低价 --- */
const r8 = computeBasket([B('商品', [['jd', 100], ['pdd', 80], ['dataoke', 90]])]);
check(r8.items[0].best.platform === 'pdd' && r8.items[0].best.final === 80,
  '三个平台时挑出最低的拼多多 80');
check(r8.items[0].spread === 20, '价差（最高−最低）= 20，实际 ' + r8.items[0].spread);
check(r8.items[0].gapToRunnerUp === 10, '与次低价的差 = 10，实际 ' + r8.items[0].gapToRunnerUp);
check(r8.items[0].alternatives.length === 2, '备选平台按价格升序列出，用户能看到次选');

/* --- 浮点 --- */
const r9 = computeBasket([B('a', [['jd', 0.1]]), B('b', [['jd', 0.2]])]);
check(r9.split.total === 0.3, '浮点相加不做 0.30000000000000004 这种脏数字（实际 ' + r9.split.total + '）');

/* --- 边界输入不该炸 --- */
check(computeBasket([]).recommend === 'none', '空清单不抛异常，给出 none');
check(computeBasket([{ q: 'x' }]).pricedCount === 0, '缺少 byPlatform 字段的脏数据不会让算法崩');
check(computeBasket(null).items.length === 0, '传 null 也返回结构完整的空结果');

/* ==========================================================================
   5. 重试策略 + 指标 + 适配器是否真的接了重试
   ========================================================================== */
say('\n— 重试策略 —');

check(isRetriable({ status: 0, json: null }), '网络层失败（status 0）值得重试');
check(isRetriable({ status: 502, json: null }), '5xx 值得重试');
check(isRetriable({ status: 429, json: null }), '429 值得重试');
check(!isRetriable({ status: 400, json: null }), '400 不重试 —— 业务错重试一万次也不会好，只会烧配额');
check(!isRetriable({ status: 200, json: { a: 1 } }), '拿到 JSON 就算成功，不做多余重试');

say('\n— 运行指标 —');
const mt = createMetrics();
mt.request('/api/compare', 200, 100);
mt.request('/api/compare', 500, 300);
mt.request('/api/health', 200, 5);
mt.limited();
mt.platform('jd', true, 50);
mt.platform('jd', false, 150);

const snap = mt.snapshot();
check(snap.requests === 3 && snap.errors === 1, '请求数与 5xx 错误数统计正确');
check(snap.rateLimited === 1, '被限流的次数被记下来了');
check(snap.avgMs === Math.round(405 / 3), '平均耗时 = 总耗时/请求数 = ' + snap.avgMs);
const jdStat = snap.platforms.find((p) => p.id === 'jd');
check(jdStat.calls === 2 && jdStat.successRate === 0.5,
  '平台成功率能算出来（京东 1/2 = 0.5），"哪个平台在拖后腿"不再只是感觉');
const cmpStat = snap.paths.find((p) => p.path === '/api/compare');
check(cmpStat.count === 2 && cmpStat.errors === 1, '按接口分组的调用量与错误数正确');

/* ==========================================================================
   5.5 密钥文件装载（envfile）—— 真实数据接入的地基
   --------------------------------------------------------------------------
   部署沙箱设不了环境变量，密钥只能随目录走（server/env.local.json）。
   这里验证三条铁律：装得进、不覆盖真实环境变量、文件坏了不炸启动。
   ========================================================================== */
say('\n— 密钥文件装载 —');
const { loadEnvFile } = require('./lib/envfile');

const envTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxm-env-'));
const envFile = path.join(envTmpDir, 'env.local.json');

// 1) 正常装载
fs.writeFileSync(envFile, JSON.stringify({
  DATAOKE_APP_KEY: 'dk-test-key',
  DATAOKE_APP_SECRET: 'dk-test-secret',
  EMPTY_KEY: '',            // 空值跳过
  NUMBER_KEY: 123,          // 非字符串跳过
}), 'utf8');
const envTarget = {};
const loaded = loadEnvFile(envFile, envTarget);
check(loaded === 2, '只装载非空字符串键（2 个联盟键进来了，空值/非字符串跳过），实际 ' + loaded);
check(envTarget.DATAOKE_APP_KEY === 'dk-test-key' && envTarget.DATAOKE_APP_SECRET === 'dk-test-secret',
  '键值原样进入目标对象');

// 2) 真实环境变量优先，不覆盖
const envTarget2 = { DATAOKE_APP_KEY: 'from-real-env' };
loadEnvFile(envFile, envTarget2);
check(envTarget2.DATAOKE_APP_KEY === 'from-real-env',
  '环境里已有的键不被文件覆盖（本地调试用 env、线上用文件，两边不打架）');

// 3) 坏文件 / 缺文件 → 返回 0 且不抛
fs.writeFileSync(envFile, '{ 坏掉的 json', 'utf8');
let badRes = -1, threw = false;
try { badRes = loadEnvFile(envFile, {}); } catch { threw = true; }
check(!threw && badRes === 0, '坏 JSON 不抛异常、返回 0（密钥缺失只是未接入，不该炸掉启动）');
check(loadEnvFile(path.join(envTmpDir, '不存在.json'), {}) === 0, '文件不存在同样安静返回 0');
fs.rmSync(envTmpDir, { recursive: true, force: true });

/* ==========================================================================
   6. 起真服务，打这一轮新增的接口
   ========================================================================== */
(async () => {
  say('\n— 重试真的接上了吗 —');
  let n1 = 0;
  const rr1 = await withRetry(async () => { n1++; return { status: 0, json: null }; }, { retries: 2, backoffMs: 1 });
  check(n1 === 3, '网络失败会重试到上限（retries=2 → 共 3 次尝试），实际 ' + n1);
  check(rr1.status === 0, '重试耗尽后原样返回最后一次结果，不抛异常打断上层');

  let n2 = 0;
  await withRetry(async () => { n2++; return { status: 400, json: null }; }, { retries: 3, backoffMs: 1 });
  check(n2 === 1, '业务错只试 1 次就放弃，不浪费配额，实际 ' + n2);

  let n3 = 0;
  await withRetry(async () => { n3++; return { status: 200, json: { ok: 1 } }; }, { retries: 3, backoffMs: 1 });
  check(n3 === 1, '成功立即返回，不做多余重试，实际 ' + n3);

  // 回归护栏：改了 lib 但适配器忘了换，是很容易漏的一步
  const dtkSrc = fs.readFileSync(path.join(__dirname, 'adapters', 'dataoke.js'), 'utf8');
  const jdSrc  = fs.readFileSync(path.join(__dirname, 'adapters', 'jd.js'), 'utf8');
  const pddSrc = fs.readFileSync(path.join(__dirname, 'adapters', 'pdd.js'), 'utf8');
  check(dtkSrc.includes('fetchJsonRetry(') && !/await fetchJson\(/.test(dtkSrc),
    '大淘客适配器走的是带重试的请求函数，不是裸 fetchJson');
  check(jdSrc.includes('fetchJsonRetry(') && !/await fetchJson\(/.test(jdSrc),
    '京东适配器走的是带重试的请求函数');
  check(pddSrc.includes('withRetry('), '拼多多适配器（自有 POST 实现）也套了重试');

  say('\n— 起真服务打新接口 —');

  const { spawn } = require('node:child_process');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const PORT = 8795;
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'error' },
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + PORT;

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await wait(120);
      try { up = (await fetch(base + '/api/health')).ok; } catch { /* 还没起来 */ }
    }
    check(up, '服务能正常启动');

    if (up) {
      /* ---- 错误结构 ---- */
      const nf = await fetch(base + '/api/nope');
      check(nf.status === 404, '不存在的接口返回 404，不是 500');
      const nfBody = await nf.json();
      check(nfBody.ok === false && nfBody.error && nfBody.error.code === 'NO_SUCH_ENDPOINT',
        '错误是结构化 { ok:false, error:{ code, message } }，前端不用猜字符串');
      check(!!nf.headers.get('x-request-id'),
        '响应头带 X-Request-Id（' + nf.headers.get('x-request-id') + '），用户报错时能直接定位');
      check(nf.headers.get('x-content-type-options') === 'nosniff', '带上了基础安全响应头');

      /* ---- 点文件不外泄：先真的放一个文件进去，避免假通过 ---- */
      const dotDir = path.join(__dirname, '..', '.data');
      const probe = path.join(dotDir, 'probe-secret.txt');
      fs.mkdirSync(dotDir, { recursive: true });
      fs.writeFileSync(probe, 'top-secret', 'utf8');
      const dot = await fetch(base + '/.data/probe-secret.txt');
      const dotTxt = await dot.text();
      check(dot.status === 404 && !dotTxt.includes('top-secret'),
        '以 . 开头的路径（.data 价格历史库）不被静态服务暴露，返回 ' + dot.status);
      try { fs.unlinkSync(probe); } catch { /* 清不掉无所谓 */ }

      /* ---- 缓存真的生效 ---- */
      const q = encodeURIComponent('缓存验证词');
      const c1 = await (await fetch(base + '/api/compare?q=' + q)).json();
      const c2 = await (await fetch(base + '/api/compare?q=' + q)).json();
      check(c1.ok === true && c2.ok === true, '两次比价请求都成功');
      check(c2.cached === true && c1.cached !== true,
        '第二次走缓存（cached:true），不再重复打外部接口');
      check(c1.cached === false, '第一次明确标注 cached:false，不假装是缓存命中');

      /* ---- 省钱清单接口 ---- */
      const bs = await fetch(base + '/api/basket?q=' + encodeURIComponent('耳机') + '&q=' + encodeURIComponent('键盘'));
      check(bs.status === 200, '省钱清单接口可用');
      const bsj = await bs.json();
      check(bsj.ok === true && typeof bsj.recommend === 'string',
        '清单返回了可执行的建议 recommend=' + bsj.recommend);
      check(Array.isArray(bsj.perQuery) && bsj.perQuery.length === 2, '逐件商品的结果都回来了');
      check(typeof bsj.reason === 'string' && bsj.reason.length > 0, '建议带人话理由：' + bsj.reason);
      check(Array.isArray(bsj.unconfigured), '未接入的平台也一并告知，用户可以自己去看');

      const bsEmpty = await fetch(base + '/api/basket');
      check(bsEmpty.status === 400, '清单不给商品时返回 400');
      const bsMany = await fetch(base + '/api/basket?' + Array.from({ length: 9 }, (_, i) => 'q=i' + i).join('&'));
      check(bsMany.status === 400, '清单超过 8 件被拒（保护外部配额，不是无限量服务）');
      const bsLong = await fetch(base + '/api/basket?q=' + 'x'.repeat(41));
      check(bsLong.status === 400, '单个关键词超长被拒');

      /* ---- 价格历史接口 ---- */
      const hs = await fetch(base + '/api/history?platform=jd&sku=123');
      check(hs.status === 200, '价格历史接口可用');
      const hsj = await hs.json();
      check(hsj.found === false, '没采到的商品返回 found:false —— 线上也不编历史');
      check(/我们自己采集/.test(hsj.note), '历史响应带着「只含自采数据」的说明');
      const hsBad = await fetch(base + '/api/history');
      check(hsBad.status === 400, '历史接口缺参数返回 400');

      /* ---- 指标接口 ---- */
      const msRes = await fetch(base + '/api/metrics');
      const msj = await msRes.json();
      check(msj.ok === true && !!msj.cache && !!msj.store, '/api/metrics 汇总了缓存与存储状态');
      check(msj.requests >= 3, '指标里的请求数在累计（当前 ' + msj.requests + '）');
      check(msj.cache.hits >= 1, '缓存命中数 > 0（' + msj.cache.hits + '）——缓存不是摆设');
      check(msj.paths.some((p) => p.path === '/api/compare'),
        '按接口分组的调用量出现了 /api/compare');
      check(typeof msj.store.skus === 'number', '指标里能看到价格历史库规模（' + msj.store.skus + ' 个商品）');

      /* ---- 静态资源不受限流影响 ---- */
      const page1 = await fetch(base + '/');
      check(page1.status === 200, '首页正常（限流不作用于静态资源，否则页面会白屏）');
    }
  } finally {
    proc.kill();
  }

  /* ==========================================================================
     7. 限流：单起一个低容量实例来验，避免把默认额度打满
     ========================================================================== */
  say('\n— 限流真的拦得住吗 —');
  const PORT2 = 8796;
  const proc2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT2), LOG_LEVEL: 'error', SXM_RL_BURST: '4', SXM_RL_RATE: '0.2' },
    stdio: 'ignore'
  });
  const base2 = 'http://127.0.0.1:' + PORT2;

  try {
    let up2 = false;
    for (let i = 0; i < 40 && !up2; i++) {
      await wait(120);
      try { up2 = (await fetch(base2 + '/api/health')).ok; } catch { /* 还没起来 */ }
    }
    check(up2, '低容量限流实例能启动（SXM_RL_BURST=4）');

    if (up2) {
      let blockedRes = null;
      let tries = 0;
      for (let i = 0; i < 12 && !blockedRes; i++) {
        tries++;
        const r = await fetch(base2 + '/api/compare?q=限流验证');
        if (r.status === 429) blockedRes = r;
      }
      check(!!blockedRes, '持续打接口会被拦下 429（打到第 ' + tries + ' 次触发）');

      if (blockedRes) {
        const body429 = await blockedRes.json();
        check(body429.error && body429.error.code === 'RATE_LIMITED', '429 也是结构化错误，code=RATE_LIMITED');
        check(!!blockedRes.headers.get('retry-after'), '429 带 Retry-After 头，客户端知道该等多久');
        check(!!body429.error.message.match(/\d+\s*秒/), '错误信息里给出具体秒数：' + body429.error.message);
      }

      // 静态资源不该被 API 限流连累
      const staticDuringLimit = await fetch(base2 + '/styles.css');
      check(staticDuringLimit.status === 200 || staticDuringLimit.status === 304,
        '临时被限流时静态资源仍然可访问（页面不会白屏）');
    }
  } finally {
    proc2.kill();
  }

  say('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, '..', 'test-quality-out.txt'), LOG.join('\n'), 'utf8');
  process.exit(fail ? 1 : 0);
})();
