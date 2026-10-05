/* 服务端验证 harness
   ------------------------------------------------------------------
   它验的是「跑起来才能发现」的东西：
     · 签名算法是否与官方文档给出的拼接示例逐字符一致
     · 解析层能否从真实字段名里抽出价格，以及字段变了会不会静默返回空
     · 价格单位换算（分 vs 元）对不对 —— 这个错了最贵，用户会看到 100 倍的价
     · 一个平台挂掉，其余平台是否照常返回

   运行：node server/test-server.js
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const LOG = [];
const say = (s) => { LOG.push(s); console.log(s); };
let pass = 0, fail = 0;
const ok  = (m) => { pass++; say('✓  ' + m); };
const bad = (m) => { fail++; say('✗  ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const sign = require('./lib/sign');
const { toYuan, pick } = require('./lib/http');
const dataoke = require('./adapters/dataoke');
const jd = require('./adapters/jd');
const pdd = require('./adapters/pdd');
const { compare } = require('./adapters');

/* ==========================================================================
   1. 京东签名：拿官方文档的拼接示例原文做黄金断言
   --------------------------------------------------------------------------
   文档 union.jd.com/helpcenter/13246-13312-108188 原文给的是：
     360buy_param_json{"goodsReqDTO":{"keyword":"鞋","pageIndex":"1"}}
     app_keyff1c4e42d4b864f45c6630f5a3604c31
     formatjsonmethodjd.union.open.goods.query...
   这就是我们实现的拼接方式。它开头对不对，一测便知。
   ========================================================================== */
say('— 签名算法 —');

const JD_OFFICIAL_PREFIX =
  '360buy_param_json{"goodsReqDTO":{"keyword":"鞋","pageIndex":"1"}}'
  + 'app_keyff1c4e42d4b864f45c6630f5a3604c31'
  + 'formatjsonmethodjd.union.open.goods.query';

const jdParams = {
  method: 'jd.union.open.goods.query',
  app_key: 'ff1c4e42d4b864f45c6630f5a3604c31',
  timestamp: '2023-01-01 12:00:00',
  format: 'json',
  v: '1.0',
  sign_method: 'md5',
  '360buy_param_json': JSON.stringify({ goodsReqDTO: { keyword: '鞋', pageIndex: '1' } })
};

const concat = sign.concatKV(jdParams);
if (concat.startsWith(JD_OFFICIAL_PREFIX)) {
  ok('京东拼接串与官方文档示例逐字符一致');
  say('     ' + concat);
} else {
  bad('京东拼接串与官方文档不一致');
  say('     期望前缀 ' + JD_OFFICIAL_PREFIX);
  say('     实际     ' + concat);
}

// 业务参数必须是紧凑 JSON —— 带空格的话签名会和官方对不上
check(
  !jdParams['360buy_param_json'].includes(': ') && !jdParams['360buy_param_json'].includes(', '),
  '京东业务参数是紧凑 JSON（无空格），与官方示例一致'
);

// 参数顺序不该影响签名结果
const shuffled = {
  '360buy_param_json': jdParams['360buy_param_json'],
  sign_method: 'md5',
  v: '1.0',
  method: 'jd.union.open.goods.query',
  format: 'json',
  timestamp: '2023-01-01 12:00:00',
  app_key: 'ff1c4e42d4b864f45c6630f5a3604c31'
};
check(sign.signJd(jdParams, 'SECRET') === sign.signJd(shuffled, 'SECRET'), '参数顺序变化不影响签名结果');

const jdSign = sign.signJd(jdParams, 'SECRET');
check(/^[0-9A-F]{32}$/.test(jdSign), '京东签名是 32 位大写十六进制：' + jdSign);

/* 京东和拼多多是同一套构造：MD5(secret + 拼接串 + secret)。
   这不是抄错，是两个平台的规则本身同构 —— 所以它们的签名结果就该一模一样。
   真正需要区分的是大淘客：它用 & 连接，且 secret 放在尾部。 */
const pdmSign = sign.signPdd(jdParams, 'SECRET');
check(jdSign === pdmSign, '京东与拼多多签名结果相同（两者规则本就同构，非实现错误）');

const dtkSign = sign.signDataoke({ appKey: 'abc', version: 'v1.2.0' }, 'SECRET');
check(dtkSign !== jdSign, '大淘客签名与京东路径不同（& 连接 + secret 在尾部）');
const dtkExpected = crypto.createHash('md5')
  .update('appKeyabc&versionv1.2.0&key=SECRET', 'utf8').digest('hex').toUpperCase();
check(dtkSign === dtkExpected, '大淘客签名 = MD5("appKeyabc&versionv1.2.0&key=SECRET")，与文档规则一致');

const ran = sign.signDataokeRan('abc', 'SECRET', '597632', '1589253503659');
const ranExpected = crypto.createHash('md5')
  .update('appKey=abc&timer=1589253503659&nonce=597632&key=SECRET', 'utf8').digest('hex').toUpperCase();
check(ran === ranExpected, '大淘客新版 signRan 拼接顺序 = appKey/timer/nonce/key，与文档一致');

check(/^\d{6}$/.test(sign.makeNonce()), '大淘客 nonce 是 6 位数字');

/* ==========================================================================
   2. 价格单位 —— 错了最贵的地方
   ========================================================================== */
say('\n— 价格单位换算 —');

check(toYuan(39.9, 'yuan') === 39.9, '元制：39.9 保持 39.9');
check(toYuan(10000, 'fen') === 100, '分制：10000 分 → 100 元（拼多多 100 元商品就是这个值）');
check(toYuan(500, 'fen') === 5, '分制：500 分 → 5 元');
check(toYuan('', 'fen') === null, '空值返回 null 而不是 0');
check(toYuan('abc', 'fen') === null, '非数字返回 null');

// 回归护栏：绝不能再靠数值大小猜单位
check(
  !/100000/.test(fs.readFileSync(path.join(__dirname, 'lib', 'http.js'), 'utf8')),
  '单位换算里没有「按数值大小猜」的启发式（过 10 万当分）——那是曾经的 bug'
);

/* ==========================================================================
   3. 拼多多解析：分 → 元 必须落对
   ========================================================================== */
say('\n— 拼多多解析 —');

const pddRaw = {
  goods_id: 123456789,
  goods_name: '测试商品 500ml',
  min_group_price: 10000,      // 分 → 100 元
  min_normal_price: 12000,     // 分 → 120 元
  coupon_discount: 500,        // 分 → 5 元
  sales_tip: '1万+',
  mall_name: '某某旗舰店',
  promotion_rate: 100,
  goods_thumbnail_url: 'https://img.example/a.jpg'
};
const pddItem = pdd._normalizeOne(pddRaw);
check(pddItem.final === 95, '拼多多到手价 = (10000-500)/100 = 95 元，实际 ' + pddItem.final);
check(pddItem.price === 120, '拼多多标价取 normal_price = 120 元，实际 ' + pddItem.price);
check(pddItem.title === '测试商品 500ml', '拼多多标题解析正确');
check(pddItem.sales === 10000, '「1万+」解析成 10000');
check(pddItem.url.includes('goods_id=123456789'), '拼多多兜底链接带上了 goods_id');

/* ==========================================================================
   4. 京东解析：双层 JSON 字符串要能拆开
   ========================================================================== */
say('\n— 京东解析 —');

const jdInner = {
  code: 200,
  data: [{
    skuName: '测试手机 256G',
    imageUrl: 'https://img.example/b.jpg',
    materialUrl: 'https://u.jd.com/xxxx',
    priceInfo: { lowestPrice: 2999, lowestCouponPrice: 2799 },
    couponInfo: { couponList: [{ discount: 200, quota: 2999 }] },
    shopInfo: { shopName: '某某自营旗舰店' },
    inOrderCount30Days: 5000,
    commissionInfo: { commissionShare: 3 }
  }]
};
const jdBody = {
  jd_union_open_goods_query_responce: { code: '0', queryResult: JSON.stringify(jdInner) }
};
check(jd._unwrap(jdBody) !== null, '京东响应壳（官方拼写 responce）能正确拆开');
check(jd._unwrap(jdBody).data.length === 1, '拆开后拿到 1 条商品');

// 两种拼写都要认
const jdBody2 = { jd_union_open_goods_query_response: { code: '0', queryResult: JSON.stringify(jdInner) } };
check(jd._unwrap(jdBody2) !== null, 'response 的正确拼写也兼容');

const jdItem = jd._normalizeOne(jdInner.data[0]);
check(jdItem.final === 2799, '京东优先用官方给的券后价 2799，实际 ' + jdItem.final);
check(jdItem.title === '测试手机 256G', '京东标题解析正确');
check(jdItem.shop === '某某自营旗舰店', '京东店铺名解析正确');

const jdStamp = jd._gmt8Stamp();
check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(jdStamp), '京东时间戳格式 = yyyy-MM-dd HH:mm:ss：' + jdStamp);

/* ==========================================================================
   4.5 机票解析 —— 用的是 ignav 官方文档给的真实响应结构
   --------------------------------------------------------------------------
   为什么这层测试不能省：机票要「自动排好序并给出价格」，排序和价格都长在
   解析层上。字段名一旦对不上，界面就会静默变空 —— 而用户看到的将是
   「一个航班都没有」，不是「字段错了」。所以这里逐字段钉死。
   样例结构来自 ignav.com 文档与其 skill 文档（两处一致）。
   ========================================================================== */
say('\n— 机票解析（ignav）—');

const ignav = require('./adapters/ignav');

// 官方文档的响应样例（含 1 个直飞、1 个经停，price 用 CNY）
const ignavBody = {
  itineraries: [
    {
      ignav_id: 'it-1',
      price: { amount: 1280, currency: 'CNY' },
      outbound: {
        carrier: '中国国际航空',
        duration_minutes: 135,
        segments: [{
          marketing_carrier_code: 'CA',
          marketing_carrier_name: '中国国际航空',
          flight_number: '1833',
          departure_airport: 'PEK',
          departure_time_local: '2026-10-20T08:30:00',
          arrival_airport: 'SHA',
          arrival_time_local: '2026-10-20T10:45:00',
          duration_minutes: 135,
          aircraft: 'Airbus A330'
        }]
      },
      cabin_class: 'economy',
      bags: { carry_on: 1, checked: 1 }
    },
    {
      ignav_id: 'it-2',
      price: { amount: 720, currency: 'CNY' },
      outbound: {
        carrier: '厦门航空',
        duration_minutes: 305,
        segments: [
          {
            marketing_carrier_code: 'MF',
            marketing_carrier_name: '厦门航空',
            flight_number: '8101',
            departure_airport: 'PEK',
            departure_time_local: '2026-10-20T06:10:00',
            arrival_airport: 'XMN',
            arrival_time_local: '2026-10-20T09:20:00',
            duration_minutes: 190
          },
          {
            marketing_carrier_code: 'MF',
            marketing_carrier_name: '厦门航空',
            flight_number: '8256',
            departure_airport: 'XMN',
            departure_time_local: '2026-10-20T10:40:00',
            arrival_airport: 'SHA',
            arrival_time_local: '2026-10-20T11:15:00',
            duration_minutes: 115
          }
        ]
      },
      cabin_class: 'economy',
      bags: { carry_on: 1, checked: 0 }
    }
  ]
};

const ignavList = ignav._extractList(ignavBody);
check(ignavList.length === 2, '机票能从 itineraries 里取出 2 条，实际 ' + ignavList.length);

const f1 = ignav._normalizeOne(ignavList[0], '¥');
check(f1.price === 1280, '机票价格解析正确（1280），实际 ' + f1.price);
check(f1.currency === 'CNY', '币种解析为 CNY');
check(f1.stops === 0 && f1.stopsText === '直飞', '单航段判为直飞');
check(f1.depTime === '08:30' && f1.arrTime === '10:45', '起降时刻切成 HH:MM：' + f1.depTime + '→' + f1.arrTime);
check(ignav._humanMin(f1.durationMin) === '2小时15分', '时长转人话：' + ignav._humanMin(f1.durationMin));
check(f1.carrier === '中国国际航空', '航司名解析正确');

const f2 = ignav._normalizeOne(ignavList[1], '¥');
check(f2.stops === 1 && f2.stopsText === '经停 1 站', '两航段判为经停 1 站');
check(f2.depAirport === 'PEK' && f2.arrAirport === 'SHA', '经停航班取首段出发、末段到达：' + f2.depAirport + '→' + f2.arrAirport);

// 排序：按价格升序 —— 这正是「自动排序好」的核心
/* ⚠ 这里必须**调真实函数**验排序，不能自己 sort 一遍再断言 ——
   那样断言的是我自己的 sort，跟被测代码无关（变异实验证明过：把
   adapter 里的排序去掉，那种断言照样全绿）。 */
check(typeof ignav.sortByPrice === 'function', 'adapter 暴露了排序函数（否则下面验的是空气）');
const sorted = ignav.sortByPrice(ignavList.map((x) => ignav._normalizeOne(x, '¥')));
check(sorted[0].price === 720 && sorted[1].price === 1280, '机票按价格升序排好（720 在前）');

// 坏数据不许抛异常，只返回 null —— 一条脏数据不能拖垮整张表
check(ignav._normalizeOne({ price: {} }) === null, '没有价格的行程返回 null 而不是崩掉');
check(ignav._normalizeOne({}) === null, '空对象返回 null');
check(ignav._extractList({ data: { itineraries: [] } }).length === 0, 'data.itineraries 空数组也能正确取出');
check(ignav._extractList(null).length === 0, 'null 返回空数组');

// 未配密钥时必须明说，不能假装有数据
check(ignav.isConfigured({}) === false, '无 IGNAV_API_KEY 时 isConfigured=false');
check(ignav.isConfigured({ IGNAV_API_KEY: 'k' }) === true, '有 IGNAV_API_KEY 时 isConfigured=true');

/* ==========================================================================
   5. 解析层遇到不认识的字段，必须自曝而不是静默返回空
   ========================================================================== */
say('\n— 失败可诊断性 —');

const weird = dataoke._normalizeOne({ 未知字段A: 1, 未知字段B: 'x' });
check(weird.title === '' && weird.final === null,
  '完全不认识的字段 → 返回空壳（会被上层过滤掉），不会产出垃圾数据');

const knownShape = dataoke._normalizeOne({
  title: '测试商品', originalPrice: 100, actualPrice: 80, couponPrice: 20,
  shopName: '某某店', monthSales: 300, itemLink: 'https://example.com/x'
});
check(knownShape.final === 80, '大淘客有 actualPrice 时直接当到手价：' + knownShape.final);
check(knownShape.price === 100, '大淘客标价取 originalPrice：' + knownShape.price);
// actualPrice 缺失时才自己减
const noActual = dataoke._normalizeOne({ title: 'x', originalPrice: 100, couponPrice: 20, itemLink: 'u' });
check(noActual.final === 80, '大淘客缺 actualPrice 时 100-20=80，实际 ' + noActual.final);

/* ==========================================================================
   6. 聚合契约：一个平台挂掉，整体还得能用
   ========================================================================== */
say('\n— 聚合并发 —');

(async () => {
  const mkAdapter = (id, name, impl) => ({
    id, name, platform: name,
    isConfigured: () => true,
    search: impl
  });

  const fake = [
    mkAdapter('good1', '平台甲', async () => ({ items: [
      { title: 'A', final: 199, price: 219, url: '', shop: '', sales: 0 },
      { title: 'B', final: 179, price: 199, url: '', shop: '', sales: 0 }
    ] })),
    mkAdapter('boom', '平台乙', async () => { throw new Error('模拟网络炸了'); }),
    mkAdapter('good2', '平台丙', async () => ({ items: [
      { title: 'C', final: 249, price: 249, url: '', shop: '', sales: 0 }
    ] })),
    { id: 'idle', name: '平台丁', platform: '丁', envKeys: ['X'], doc: '',
      isConfigured: () => false, search: async () => ({ items: [] }) }
  ];

  const r = await compare('测试', process.env, { adapters: fake, keep: 5 });

  const boom = r.platforms.find((x) => x.id === 'boom');
  check(boom && boom.ok === false, '抛异常的平台被隔离成 ok:false，没有让整体失败');
  check(r.platforms.length === 3, '其余 3 个已配置平台照常返回');
  check(r.platforms.map((x) => x.id).join(',') === 'good1,good2,boom',
    '结果按最低到手价排序（179 → 199 → 拿不到价），实际顺序 ' + r.platforms.map((x) => x.id).join(','));
  check(r.platforms[0].lowest.final === 179, '排在最前的平台其最低价 = 179');
  check(r.unconfigured.length === 1 && r.unconfigured[0].id === 'idle', '未配置的平台单独列在 unconfigured 里');
  check(!!r.disclaimer && r.disclaimer.includes('不是严格同款比价'),
    '返回里带上了「这不是严格同款比价」的说明——不能让用户误以为是同款对比');

  /* ==========================================================================
     7. 静态服务与路由：起真服务打一遍
     ========================================================================== */
  say('\n— 起真服务打接口 —');

  const { spawn } = require('node:child_process');
  const PORT = 8791;
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });

  const base = 'http://127.0.0.1:' + PORT;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 等端口起来
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await wait(120);
      try { up = (await fetch(base + '/api/health')).ok; } catch { /* 还没起来 */ }
    }
    check(up, '服务能正常启动并响应 /api/health');

    if (up) {
      const h = await (await fetch(base + '/api/health')).json();
      check(h.ok === true && Array.isArray(h.adapters), '/api/health 返回各平台配置状态');
      check(h.adapters.some((a) => a.id === 'dataoke'), '/api/health 里能看到大淘客');

      const noQ = await fetch(base + '/api/compare');
      check(noQ.status === 400, '缺少 q 参数返回 400，而不是 500');

      const cmp = await (await fetch(base + '/api/compare?q=' + encodeURIComponent('耳机'))).json();
      check(cmp.ok === true && Array.isArray(cmp.platforms), '无密钥时 /api/compare 仍返回结构完整的结果');
      check(cmp.unconfigured.length === 3, '无密钥时三个平台都列在 unconfigured 里');
      check(cmp.platforms.length === 0, '无密钥时不返回任何平台结果——不编数据');

      const page = await fetch(base + '/');
      const html = await page.text();
      check(page.ok && html.includes('省心买'), '根路径能正常返回页面');

      const md = await fetch(base + '/README.md');
      check(md.status === 200, '静态文件服务正常（顺带能读 README）');

      const traversal = await fetch(base + '/../../etc/passwd');
      check(traversal.status === 403 || traversal.status === 404,
        '路径穿越被挡住（返回 ' + traversal.status + '）');

      /* ---- 静态资源的 ETag / 304 ----
         serveStatic 的注释一直写着「保留 304 协商，命中时不需要重传体积」，
         但响应里既没有 ETag 也没有 Last-Modified —— 浏览器没有校验子可带，
         304 永远不会发生，每次访问都把 app.js + styles.css + data.js 全量重传。
         这是 2026-10-05 在线上响应头里实测出来的（CloudStudio 网关回的也是裸 no-cache）。
         下面这几条就是盯着「注释承诺过、代码没做到」的那件事。 */
      const r1 = await fetch(base + '/app.js');
      const etag = r1.headers.get('etag');
      const cc = r1.headers.get('cache-control') || '';
      check(r1.status === 200 && !!etag, '静态资源带 ETag（没有它 304 无从谈起）');
      check(cc.includes('no-cache'), '仍然是 no-cache：发布后必须能立刻拿到新版本');

      /* ETag 必须是**内容**哈希。要是哪天有人图省事改成 mtime+size，
         发布时 mtime 被一起带过去、内容变了而字节数恰好没变，
         就会算出同一个 ETag 发假 304 —— 那是「改了没生效」里最难查的一种。 */
      const appBuf = fs.readFileSync(path.join(__dirname, '..', 'app.js'));
      const wantEtag = '"' + crypto.createHash('sha1').update(appBuf).digest('hex').slice(0, 32) + '"';
      check(etag === wantEtag, 'ETag 就是 app.js 的内容哈希（换成 mtime+size 会发假 304）');

      const r2 = await fetch(base + '/app.js', { headers: { 'If-None-Match': etag } });
      check(r2.status === 304, '带对得上的 If-None-Match 回 304');
      check((await r2.text()) === '', '304 不带 body —— 这才叫「不重传体积」');

      const r3 = await fetch(base + '/app.js', { headers: { 'If-None-Match': '"nope"' } });
      check(r3.status === 200, 'If-None-Match 对不上时老实回 200 全量，不能糊弄');

      const r4 = await fetch(base + '/app.js', { headers: { 'If-None-Match': 'W/' + etag } });
      check(r4.status === 304, '容忍弱校验写法 W/"..."（中间代理会这么改写）');

      const r5 = await fetch(base + '/styles.css');
      check(!!r5.headers.get('etag') && r5.headers.get('etag') !== etag,
        '不同文件 ETag 不同（不是拿文件名或时间糊出来的）');

      const r6 = await fetch(base + '/');
      check(!!r6.headers.get('etag'), 'index.html 也带 ETag');

      /* ---- 机票接口：没密钥时必须如实说，且绝不能给假价格 ---- */
      const fl = await (await fetch(base + '/api/flights?from=BJS&to=SHA&date=2026-10-20')).json();
      check(fl.ok === true, '/api/flights 无密钥时仍返回 200 与完整结构');
      check(fl.configured === false, '无密钥时 configured=false —— 前端据此退回手动查');
      check(Array.isArray(fl.flights) && fl.flights.length === 0,
        '无密钥时 flights 为空数组，不给任何假价格');
      check(Array.isArray(fl.platforms) && fl.platforms.length > 0,
        '无密钥时返回手动查入口（去哪儿 / 携程 / 飞猪）');

      const flNoRoute = await fetch(base + '/api/flights?from=BJS');
      check(flNoRoute.status === 400, '缺目的地返回 400');
      const flNoDate = await fetch(base + '/api/flights?from=BJS&to=SHA');
      check(flNoDate.status === 400, '缺日期返回 400');
      const flBadDate = await fetch(base + '/api/flights?from=BJS&to=SHA&date=2026/10/20');
      check(flBadDate.status === 400, '日期格式不对返回 400（不要 2026/10/20 这种）');

      /* ---- /api/health 必须如实反映"哪些真的实现了" ---- */
      const healthAll = await (await fetch(base + '/api/health')).json();
      const healthIds = healthAll.adapters.map((a) => a.id);

      check(healthAll.adapters.every((a) => a.implemented === true),
        '/api/health 的每条 adapter 都显式标了 implemented');
      check(healthIds.indexOf('ignav') !== -1,
        '机票适配器 ignav 出现在 /api/health 里（它早就实现了，以前漏报导致界面说"配了也没用"');
      check(healthAll.limits && healthAll.limits.basketThreshold === 10,
        '/api/health 报出了 basketThreshold=10，前端不用自己兜底一个可能打架的数');

      /* ---- 构建标识：回答"线上跑的到底是哪一版" ----
         两个线上地址是两套部署、其中一个要手动重发，所以"我到底发出去了没有"
         会反复出现。这个值是唯一能当场断案的证据，必须有断言钉住它**真的是**
         app.js 的内容哈希 —— 否则哪天被改成 mtime 或写死的字符串，
         它就会变成一个"看着像证据"的摆设。 */
      const pkgNow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      const appBytes = fs.readFileSync(path.join(__dirname, '..', 'app.js'));
      const wantBuild = crypto.createHash('sha1').update(appBytes).digest('hex').slice(0, 12);

      check(healthAll.version === pkgNow.version,
        '/api/health 报的 version 就是 package.json 的 ' + pkgNow.version);
      check(healthAll.buildId === wantBuild,
        '/api/health 的 buildId 就是 app.js 的内容哈希（' + wantBuild + '），换 mtime 会发假版本');
      check(typeof healthAll.buildId === 'string' && healthAll.buildId.length === 12,
        'buildId 是定长的短指纹，能直接念给人听（' + healthAll.buildId + '）');
      // 换一个字节就得换一个指纹，否则"能对出版本"是假的
      check(crypto.createHash('sha1').update(Buffer.concat([appBytes, Buffer.from('x')])).digest('hex').slice(0, 12) !== wantBuild,
        'app.js 差一个字节，buildId 就会不同（指纹是真的，不是摆设）');

      /* ---- 防漂移：前端目录（data.js）↔ 服务端事实（/api/health）双向核对 ----
         这是本次修复的**核心保险**：只要有人在 data.js 里加一个"已实现"的数据源
         却没写 adapter，或者写了 adapter 却忘了登记，这条断言立刻变红。
         没有它，两边迟早再次各说各话。 */
      const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
      const catMatch = /const ADAPTER_REGISTRY = (\[[\s\S]*?\n\]);/.exec(dataSrc);
      check(!!catMatch, '能从 data.js 里读出 ADAPTER_REGISTRY 目录');
      const catalog = catMatch ? vm.runInNewContext('(' + catMatch[1] + ')') : [];

      const implIds   = catalog.filter((c) => !c.planned).map((c) => c.id);
      const plannedIds = catalog.filter((c) => c.planned).map((c) => c.id);
      const missing = implIds.filter((id) => healthIds.indexOf(id) === -1);
      const leaked  = plannedIds.filter((id) => healthIds.indexOf(id) !== -1);
      const orphan  = healthIds.filter((id) => !catalog.some((c) => c.id === id));

      check(missing.length === 0,
        '目录里标"已实现"的每个数据源，服务端都真的有 adapter' + (missing.length ? '：缺 ' + missing.join(',') : ''));
      check(leaked.length === 0,
        '目录里标"规划中"的，服务端确实没有' + (leaked.length ? '：却出现了 ' + leaked.join(',') : ''));
      check(orphan.length === 0,
        '服务端有的每个 adapter，前端目录里都有条目（否则界面会漏展示）' + (orphan.length ? '：多出 ' + orphan.join(',') : ''));
      check(plannedIds.length === 3, '当前有 3 个"规划中"的数据源（haodanku / meituan / ctrip），实际 ' + plannedIds.length);

      /* ---- 「麻烦门槛」¥0 的回归：不传 th 必须用默认值，别被 Number(null) 抹成 0 ---- */
      const bkDefault = await (await fetch(base + '/api/basket?q=' + encodeURIComponent('猫粮') + '&q=' + encodeURIComponent('洗衣液'))).json();
      check(bkDefault.threshold === 10,
        '不传 th 时门槛用默认值 10（不是被 Number(null) 抹成的 0），实际 ' + bkDefault.threshold);
      check(bkDefault.notes.some((n) => /麻烦门槛 ¥10/.test(n)),
        '提示文案里写的是「麻烦门槛 ¥10」而不是 ¥0');

      /* 但用户**显式**传 th=0 是合法意图（"一分钱都嫌麻烦"），不能也被当成缺失 */
      const bkZero = await (await fetch(base + '/api/basket?q=' + encodeURIComponent('猫粮') + '&th=0')).json();
      check(bkZero.threshold === 0, '显式传 th=0 仍然生效（缺失与 0 是两回事），实际 ' + bkZero.threshold);

      const bkFive = await (await fetch(base + '/api/basket?q=' + encodeURIComponent('猫粮') + '&th=5')).json();
      check(bkFive.threshold === 5, '显式传 th=5 生效，实际 ' + bkFive.threshold);
    }
  } finally {
    proc.kill();
  }

  say('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  fs.writeFileSync(path.join(__dirname, '..', 'test-server-out.txt'), LOG.join('\n'), 'utf8');
  process.exit(fail ? 1 : 0);
})();
